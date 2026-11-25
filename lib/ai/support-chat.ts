import type { SupportCategory } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { addTraderMessage, createTicket } from '@/lib/support/service'
import type { SupportBrief } from '@/lib/support/brief'
import { SUPPORT_SYSTEM_INSTRUCTIONS, buildPftKnowledge, RULES_SOURCE_VERSION } from './pft-knowledge'
import { AiUnavailableError, type AssistantGenerator, type ChatTurn } from './gemini'
import { generateAssistant } from './provider'
import {
  prismaAiSupportIdempotencyStore,
  runIdempotentRequest,
  supportChatFingerprint,
  type IdempotencyStore,
} from './request-idempotency'
import { loadSupportPricing } from './support-pricing'

export type Handoff = { publicId: string; subject: string; reused: boolean }

export type SupportChatResult = {
  answer: string | null
  handoff: Handoff | null
  handoffReason: string | null
  /** True when the assistant could not answer and a handoff is available on request. */
  suggestedHandoff: boolean
  /** Category the model picked for an unanswered question, reused on confirmation. */
  suggestedCategory: SupportCategory | null
}

function readSupportChatResult(value: unknown): SupportChatResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.suggestedHandoff !== 'boolean') return null
  const suggestedCategoryRaw = record.suggestedCategory === null
    ? null
    : typeof record.suggestedCategory === 'string' ? record.suggestedCategory : undefined
  if (suggestedCategoryRaw === undefined) return null
  const suggestedCategory: SupportCategory | null =
    suggestedCategoryRaw === null ? null
      : SUPPORT_CATEGORIES.includes(suggestedCategoryRaw as SupportCategory) ? (suggestedCategoryRaw as SupportCategory) : null
  if (suggestedCategoryRaw !== null && suggestedCategory === null) return null
  if (typeof record.answer === 'string') {
    if (record.handoff !== null || record.handoffReason !== null || record.suggestedHandoff || suggestedCategory !== null) return null
    return { answer: record.answer, handoff: null, handoffReason: null, suggestedHandoff: false, suggestedCategory: null }
  }
  if (record.answer !== null || typeof record.handoffReason !== 'string') return null

  if (record.handoff === null) {
    // A suggested handoff: no ticket exists yet, the trader must confirm first.
    if (!record.suggestedHandoff || suggestedCategory === null) return null
    return { answer: null, handoff: null, handoffReason: record.handoffReason, suggestedHandoff: true, suggestedCategory }
  }

  if (!record.handoff || typeof record.handoff !== 'object' || Array.isArray(record.handoff)) return null
  const handoffValue = record.handoff as Record<string, unknown>
  if (
    typeof handoffValue.publicId !== 'string'
    || typeof handoffValue.subject !== 'string'
    || typeof handoffValue.reused !== 'boolean'
    || record.suggestedHandoff
  ) return null

  return {
    answer: null,
    handoff: {
      publicId: handoffValue.publicId,
      subject: handoffValue.subject,
      reused: handoffValue.reused,
    },
    handoffReason: record.handoffReason,
    suggestedHandoff: false,
    suggestedCategory: null,
  }
}

export class HandoffFailedError extends Error {
  constructor() {
    super('Support ticket could not be created')
    this.name = 'HandoffFailedError'
  }
}

const HANDOFF_SUBJECT_PREFIX = 'Support chat:'
const DEDUPE_WINDOW_MS = 24 * 60 * 60_000
const SUPPORT_CATEGORIES: SupportCategory[] = ['GENERAL', 'CHALLENGE', 'PAYOUT', 'KYC', 'ACCOUNT', 'TECHNICAL', 'RULES']

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

function buildBrief(input: {
  source: HandoffSource
  reason: string
  category: SupportCategory
  history: ChatTurn[]
  context: TraderContext | null
}): SupportBrief {
  return {
    source: input.source,
    reason: input.reason,
    category: input.category,
    rulesVersion: RULES_SOURCE_VERSION,
    history: input.history.slice(-4).map((turn) => ({
      role: turn.role,
      content: turn.content.replace(/\s+/g, ' ').slice(0, 400),
    })),
    context: {
      kycStatus: input.context?.kycStatus ?? 'unknown',
      accounts: (input.context?.accounts ?? []).map((account) => ({
        displayId: account.displayId,
        status: account.status,
        planSize: account.planSize,
        phase: account.phase,
      })),
    },
  }
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

export type SupportChatDependencies = {
  loadPricing: typeof loadSupportPricing
  loadTraderContext: typeof loadTraderContext
  findRecentHandoffTicket: typeof findRecentHandoffTicket
  addTraderMessage: typeof addTraderMessage
  createTicket: typeof createTicket
  idempotencyStore: IdempotencyStore
}

const DEFAULT_DEPENDENCIES: SupportChatDependencies = {
  loadPricing: loadSupportPricing,
  loadTraderContext,
  findRecentHandoffTicket,
  addTraderMessage,
  createTicket,
  idempotencyStore: prismaAiSupportIdempotencyStore,
}

/**
 * Answers a trader question. When the assistant cannot answer a question
 * confidently, it does NOT open a ticket on its own: it returns
 * `suggestedHandoff` and the trader decides (`forceHandoff: true` confirms the
 * transfer). A confirmed handoff always makes sure a human sees it: the message
 * is appended to the trader's recent assistant handoff ticket, or a new ticket
 * is created. The response never claims a transfer that was not stored.
 */
export type HandoffSource = 'agent' | 'user' | 'system'

/**
 * Handoff input. `handoffSource` is stored on the ticket's first message so
 * staff can tell an agent-suggested transfer from a user-requested one.
 */
export type HandoffInput = {
  userId: string
  message: string
  history: ChatTurn[]
  forceHandoff: boolean
  idempotencyKey: string
  /** Category proposed by a previous suggestion; used only with forceHandoff. */
  suggestedCategory?: SupportCategory
  /** Why the model could not answer; used only with a confirmed handoff. */
  suggestedReason?: string
  handoffSource?: HandoffSource
  request: Request
  generate?: AssistantGenerator
}

export async function handleSupportChat(input: HandoffInput, overrides: Partial<SupportChatDependencies> = {}): Promise<SupportChatResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const operation = () => handleSupportChatOnce(input, dependencies)

  return runIdempotentRequest(
    dependencies.idempotencyStore,
    input.userId,
    input.idempotencyKey,
    supportChatFingerprint({
      message: input.message,
      history: input.history,
      forceHandoff: input.forceHandoff,
      suggestedCategory: input.suggestedCategory ?? null,
      suggestedReason: input.forceHandoff ? (input.suggestedReason ?? null) : null,
      handoffSource: input.handoffSource ?? null,
    }),
    operation,
    readSupportChatResult,
  )
}

async function handleSupportChatOnce(
  input: HandoffInput,
  dependencies: SupportChatDependencies,
): Promise<SupportChatResult> {
  const pricing = await dependencies.loadPricing()
  const knowledge = buildPftKnowledge(pricing)
  const generate = input.generate ?? generateAssistant

  // A confirmed handoff keeps the category and reason the model picked for the
  // original suggestion; a forced handoff without a suggestion states it plainly.
  let category: SupportCategory = input.suggestedCategory ?? 'GENERAL'
  let reason: string | null = input.forceHandoff ? (input.suggestedReason ?? 'user_requested_human') : null

  if (!input.forceHandoff) {
    try {
      const result = await generate({
        systemInstruction: SUPPORT_SYSTEM_INSTRUCTIONS,
        knowledge,
        history: input.history,
        message: input.message,
      })
      if (result.resolved) {
        return { answer: result.answer, handoff: null, handoffReason: null, suggestedHandoff: false, suggestedCategory: null }
      }
      category = result.category
      reason = result.handoffReason ?? 'not_covered_by_rules'
    } catch (error) {
      logAiFailure(error, input.request)
      reason = error instanceof AiUnavailableError ? error.reason : 'ai_unavailable'
    }
    // Offer the transfer; the ticket is created only when the trader confirms.
    // The model's category rides along so the confirmation does not lose it.
    return { answer: null, handoff: null, handoffReason: reason, suggestedHandoff: true, suggestedCategory: category }
  }

  const finalReason = reason ?? 'not_covered_by_rules'
  const context = await dependencies.loadTraderContext(input.userId)
  const brief = buildBrief({
    source: input.handoffSource ?? 'user',
    reason: finalReason,
    category,
    history: input.history,
    context,
  })

  // Reuse a recent assistant handoff ticket instead of spamming a new one.
  const existing = await dependencies.findRecentHandoffTicket(input.userId)
  if (existing) {
    const appended = await dependencies.addTraderMessage({
      userId: input.userId,
      ref: existing.publicId,
      body: input.message,
      idempotencyKey: input.idempotencyKey,
      messageMetadata: brief,
      request: input.request,
    }).catch(() => null)
    if (appended && !('error' in appended)) {
      return {
        answer: null,
        handoff: { publicId: existing.publicId, subject: existing.subject, reused: true },
        handoffReason: finalReason,
        suggestedHandoff: false,
        suggestedCategory: null,
      }
    }
    // Closed or otherwise unavailable: fall through and create a fresh ticket.
  }

  try {
    // A retry that races this call uses the same idempotency key, which maps to
    // a deterministic publicId: the unique index makes the second insert lose
    // and return the ticket created by the first request.
    const ticket = await dependencies.createTicket({
      userId: input.userId,
      subject: handoffSubject(input.message),
      category,
      body: input.message,
      request: input.request,
      idempotencyKey: input.idempotencyKey,
      messageMetadata: brief,
    })
    return {
      answer: null,
      handoff: { publicId: ticket.publicId, subject: ticket.subject, reused: ticket.reused },
      handoffReason: finalReason,
      suggestedHandoff: false,
      suggestedCategory: null,
    }
  } catch {
    // Never claim a transfer that was not stored.
    console.warn('[pft ai]', JSON.stringify({ event: 'ai_handoff_failed', requestId: requestCorrelationId(input.request) }))
    throw new HandoffFailedError()
  }
}
