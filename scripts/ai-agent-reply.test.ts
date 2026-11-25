import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentReply, STAFF_JSON_CONTRACT } from '../lib/ai/agent-reply'
import { parseAssistantResponse } from '../lib/ai/gemini'
import { generateWithNvidia, NVIDIA_DEFAULT_MODEL } from '../lib/ai/nvidia'
import { AiUnavailableError } from '../lib/ai/errors'

/**
 * The staff desk and the trader assistant speak two different JSON contracts.
 * These tests pin the behaviour that caused the production 500:
 * the staff reply was rejected by the strict trader parser.
 */

const staffParse = (text: string) => ({
  answer: parseAgentReply(text).reply,
  resolved: false,
  category: 'GENERAL' as const,
  handoffReason: null,
  citations: [],
})

test('staff parser reads the staff contract', () => {
  const parsed = parseAgentReply('{"reply":"Check the payout ledger.","proposedActions":[]}')
  assert.equal(parsed.reply, 'Check the payout ledger.')
})

test('staff parser also accepts a trader-shaped answer', () => {
  const parsed = parseAgentReply('{"answer":"Check the payout ledger.","resolved":false}')
  assert.equal(parsed.reply, 'Check the payout ledger.')
})

test('staff parser reads JSON wrapped in a code fence', () => {
  const parsed = parseAgentReply('```json\n{"reply":"Draft reply."}\n```')
  assert.equal(parsed.reply, 'Draft reply.')
})

test('staff parser reads JSON embedded in prose', () => {
  const parsed = parseAgentReply('Here is my answer: {"reply":"Draft reply."} — let me know.')
  assert.equal(parsed.reply, 'Draft reply.')
})

test('staff parser keeps the model words when the reply is not JSON', () => {
  const parsed = parseAgentReply('The customer should be offered a manual payout review.')
  assert.equal(parsed.reply, 'The customer should be offered a manual payout review.')
})

test('staff parser falls back to the raw text for JSON without a reply', () => {
  const parsed = parseAgentReply('{"tool":"file_appeal"}')
  assert.equal(parsed.reply, '{"tool":"file_appeal"}')
})

test('staff parser trims and truncates the draft', () => {
  const parsed = parseAgentReply(`  ${'x'.repeat(5_000)}  `)
  assert.equal(parsed.reply.length, 4_000)
})

test('staff parser fails only on an empty answer', () => {
  assert.throws(
    () => parseAgentReply('   '),
    (error: unknown) =>
      error instanceof AiUnavailableError && error.detail === 'empty_answer',
  )
})

test('the trader parser stays strict for a staff-shaped reply', () => {
  assert.throws(
    () => parseAssistantResponse('{"reply":"Check the payout ledger."}'),
    (error: unknown) =>
      error instanceof AiUnavailableError && error.detail === 'empty_answer',
  )
  const trader = parseAssistantResponse(
    '{"answer":"Check the ledger.","resolved":false,"category":"PAYOUT","handoffReason":""}',
  )
  assert.equal(trader.answer, 'Check the ledger.')
  assert.equal(trader.resolved, false)
})

function nvidiaResponse(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function systemPromptOf(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role?: string; content?: string }[] }
  return parsed.messages?.find((message) => message.role === 'system')?.content ?? ''
}

test('the nvidia provider uses the staff parser and contract when given', async () => {
  process.env.NVIDIA_API_KEY = 'test-key'
  let sentBody = ''
  const result = await generateWithNvidia(
    { systemInstruction: 'Staff desk.', knowledge: '', history: [], message: 'hi' },
    {
      parse: staffParse,
      contractPrompt: STAFF_JSON_CONTRACT,
      fetchImpl: async (_url, init) => {
        sentBody = String(init?.body ?? '')
        return nvidiaResponse('{"reply":"Draft reply."}')
      },
    },
  )
  assert.equal(result.answer, 'Draft reply.')
  const systemPrompt = systemPromptOf(sentBody)
  assert.ok(systemPrompt.includes('{"reply": string'))
  assert.ok(!systemPrompt.includes('"resolved": boolean'))
})

test('the nvidia provider keeps the strict trader contract by default', async () => {
  process.env.NVIDIA_API_KEY = 'test-key'
  let sentBody = ''
  await assert.rejects(
    generateWithNvidia(
      { systemInstruction: 'Trader assistant.', knowledge: '', history: [], message: 'hi' },
      {
        fetchImpl: async (_url, init) => {
          sentBody = String(init?.body ?? '')
          return nvidiaResponse('{"reply":"Draft reply."}')
        },
      },
    ),
    (error: unknown) => error instanceof AiUnavailableError,
  )
  const systemPrompt = systemPromptOf(sentBody)
  assert.ok(systemPrompt.includes('"resolved": boolean'))
  assert.ok(!systemPrompt.includes('{"reply": string'))
  assert.equal(NVIDIA_DEFAULT_MODEL.includes('nvidia/'), true)
})
