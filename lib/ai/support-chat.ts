import type { SupportCategory } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { addTraderMessage, createTicket } from '@/lib/support/service'
import { SUPPORT_SYSTEM_INSTRUCTIONS, buildPftKnowledge, RULES_SOURCE_VERSION } from './pft-knowledge'
import { AiUnavailableError, type AssistantGenerator, type ChatTurn } from './gemini'
import { generateAssistant } from './provider'
import { loadSupportPricing } from './support-pricing'

export type Handoff = { publicId: string; subject: string; reused: boolean }

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

const HANDOFF_SUBJECT_PREFIX = 'Support chat:'
const DEDUPE_WINDOW_MS = 24 * 60 * 60_000

/** Correlation id from the edge/platform, safe to log. */
function requestCorrelationId(request: Request) {
  const raw = request.headers.get('x-vercel-id') ?? request.headers.get('x-request-id') ?? null
  return raw ? raw.slice(0, 120) : null
}

/**
 * Structured, privacy-safe failure log: reason/status/code/model/request id only.
 * Never includes the API key, provider response bodies, user text or PII.
 */
function logAiFailure(error: unknown, request: Request) {
  const correlationId = requestCorrelationId(request)
  if (error instanceof AiUnavailableError) {
    console.warn(
      '[pft ai]',
      JSON.stringify({
        event: 'ai_unavailable',
        reason: error.reason,
        status: error.status,
        code: error.code,
        model: error.model,
        provider: error.provider,
        detail: error.detail,
        contentLength: error.contentLength,
        finishReason: error.finishReason,
        requestId: correlationId,
      }),
    )
    return
  }
  console.warn(
    '[pft ai]',
    JSON.stringify({
      event: 'ai_error',
      name: error instanceof Error ? error.name : 'unknown',
      requestId: correlationId,
    }),
  )
}

export function handoffSubject(message: string) {
  const cleaned = message.replace(/\s+/g, ' ').trim()
  const subject = `${HANDOFF_SUBJECT_PREFIX} ${cleaned.slice(0, 140)}`.slice(0, 160)
  return subject.length >= 4 ? subject : 'Support chat request'
}

function conversationExcerpt(history: ChatTurn[]) {
  if (history.length === 0) return 'No earlier assistant messages in this session.'
  return history
    .slice(-4)
    .map((turn) => `${turn.role === 'assistant' ? 'Assistant' : 'Trader'}: ${turn.content.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n')
}

type TraderContext = {
  kycStatus: string
  accounts: { displayId: string; status: string; planSize: number; phase: string }[]
}

async function loadTraderContext(userId: string): Promise<TraderContext | null> {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        accounts: {
          select: { displayId: true, status: true, planSize: true, phase: true },
          orderBy: { createdAt: 'desc' },
          take: 3,
        },
      },
    })
  } catch {
    return null
  }
}

function handoffBody(input: {
  message: string
  reason: string
  history: ChatTurn[]
  context: TraderContext | null
}) {
  const accounts = input.context?.accounts.length
    ? input.context.accounts
        .map((account) => `- ${account.displayId} · ${account.status} · $${account.planSize.toLocaleString('en-US')} · ${account.phase}`)
        .join('\n')
    : '- No trading accounts on this login.'

  return [
    'Message from the PFT assistant chat:',
    '',
    input.message,
    '',
    `AI handoff reason: ${input.reason}`,
    '',
    'Conversation context (most recent turns):',
    conversationExcerpt(input.history),
    '',
    'Trader context (server-side):',
    `KYC: ${input.context?.kycStatus ?? 'unknown'}`,
    'Accounts (newest first, max 3):',
    accounts,
    `Rules version: ${RULES_SOURCE_VERSION}`,
  ]
    .join('\n')
    .slice(0, 5_000)
}

async function findRecentHandoffTicket(userId: string) {
  try {
    return await prisma.supportTicket.findFirst({
      where: {
        userId,
        subject: { startsWith: HANDOFF_SUBJECT_PREFIX },
        status: { not: 'CLOSED' },
        updatedAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      orderBy: { updatedAt: 'desc' },
      select: { publicId: true, subject: true },
    })
  } catch {
    return null
  }
}

/**
 * Answers a trader question and — when the assistant cannot answer confidently —
 * makes sure a human sees it: the message is appended to the trader's recent
 * assistant handoff ticket, or a new ticket is created. The response never
 * claims a transfer that was not stored.
 */
export async function handleSupportChat(input: {
  userId: string
  message: string
  history: ChatTurn[]
  forceHandoff: boolean
  idempotencyKey: string | null
  request: Request
  generate?: AssistantGenerator
}): Promise<SupportChatResult> {
  const pricing = await loadSupportPricing()
  const knowledge = buildPftKnowledge(pricing)
  const generate = input.generate ?? generateAssistant

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
      category = result.category
      reason = result.handoffReason ?? 'not_covered_by_rules'
    } catch (error) {
      logAiFailure(error, input.request)
      reason = error instanceof AiUnavailableError ? error.reason : 'ai_unavailable'
    }
  }

  const finalReason = reason ?? 'not_covered_by_rules'
  const context = await loadTraderContext(input.userId)
  const body = handoffBody({ message: input.message, reason: finalReason, history: input.history, context })

  // Reuse a recent assistant handoff ticket instead of spamming a new one.
  const existing = await findRecentHandoffTicket(input.userId)
  if (existing) {
    const appended = await addTraderMessage({
      userId: input.userId,
      ref: existing.publicId,
      body,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
    }).catch(() => null)
    if (appended && !('error' in appended)) {
      return {
        answer: null,
        handoff: { publicId: existing.publicId, subject: existing.subject, reused: true },
        handoffReason: finalReason,
      }
    }
    // Closed or otherwise unavailable: fall through and create a fresh ticket.
  }

  try {
    // A retry that races this call uses the same idempotency key, which maps to
    // a deterministic publicId: the unique index makes the second insert lose
    // and return the ticket created by the first request.
    const ticket = await createTicket({
      userId: input.userId,
      subject: handoffSubject(input.message),
      category,
      body,
      request: input.request,
      idempotencyKey: input.idempotencyKey,
    })
    return {
      answer: null,
      handoff: { publicId: ticket.publicId, subject: ticket.subject, reused: ticket.reused },
      handoffReason: finalReason,
    }
  } catch {
    // Never claim a transfer that was not stored.
    console.warn('[pft ai]', JSON.stringify({ event: 'ai_handoff_failed', requestId: requestCorrelationId(input.request) }))
    throw new HandoffFailedError()
  }
}
