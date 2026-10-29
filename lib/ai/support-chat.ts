import { createTicket } from '@/lib/support/service'
import type { SupportCategory } from '@prisma/client'
import {
  SUPPORT_SYSTEM_INSTRUCTIONS,
  buildPftKnowledge,
} from './pft-knowledge'
import { AiUnavailableError, generateWithGemini, type AssistantGenerator, type ChatTurn } from './gemini'
import { loadSupportPricing } from './support-pricing'

export type Handoff = { publicId: string; subject: string }

export type SupportChatResult = {
  answer: string | null
  handoff: Handoff | null
  handoffReason: string | null
}

export class HandoffFailedError extends Error {
  constructor() {
    super('Support ticket could not be created')
    this.name = 'HandoffFailedError'
  }
}

export function handoffSubject(message: string) {
  const cleaned = message.replace(/\s+/g, ' ').trim()
  const subject = `Support chat: ${cleaned.slice(0, 140)}`.slice(0, 160)
  return subject.length >= 4 ? subject : 'Support chat request'
}

function handoffBody(message: string, reason: string) {
  return [
    'Message from the PFT assistant chat:',
    '',
    message,
    '',
    `AI handoff reason: ${reason}`,
  ].join('\n').slice(0, 5_000)
}

/**
 * Answers a trader question and — when the assistant cannot answer confidently —
 * creates a real support ticket before telling the user a human will follow up.
 * `generate` is injectable so tests can exercise both paths without the network.
 */
export async function handleSupportChat(input: {
  userId: string
  message: string
  history: ChatTurn[]
  forceHandoff: boolean
  request: Request
  generate?: AssistantGenerator
}): Promise<SupportChatResult> {
  const pricing = await loadSupportPricing()
  const knowledge = buildPftKnowledge(pricing)
  const generate = input.generate ?? generateWithGemini

  let answer: string | null = null
  let category: SupportCategory = 'GENERAL'
  let reason: string | null = input.forceHandoff ? 'user_requested_human' : null

  if (!input.forceHandoff) {
    try {
      const result = await generate({
        systemInstruction: SUPPORT_SYSTEM_INSTRUCTIONS,
        knowledge,
        history: input.history,
        message: input.message,
      })
      if (result.resolved) {
        return { answer: result.answer, handoff: null, handoffReason: null }
      }
      // Not confident: keep the topic for the operator, but do not show a partial answer.
      category = result.category
      reason = result.handoffReason ?? 'not_covered_by_rules'
    } catch (error) {
      reason = error instanceof AiUnavailableError ? error.reason : 'ai_unavailable'
    }
  }

  let ticket
  try {
    ticket = await createTicket({
      userId: input.userId,
      subject: handoffSubject(input.message),
      category,
      body: handoffBody(input.message, reason ?? 'not_covered_by_rules'),
      request: input.request,
    })
  } catch {
    // Never claim a transfer that was not stored.
    throw new HandoffFailedError()
  }

  return {
    answer,
    handoff: { publicId: ticket.publicId, subject: ticket.subject },
    handoffReason: reason,
  }
}
