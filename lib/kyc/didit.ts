import { createHmac, timingSafeEqual } from 'crypto'

const DIDIT_API_BASE = 'https://verification.didit.me/v3'
const WORKFLOW_CACHE_MS = 5 * 60_000

export type DiditSession = {
  session_id: string
  url: string
  status: string
}

type DiditWorkflow = {
  workflow_id: string
  workflow_type: string
  status: string
  is_default?: boolean
}

let workflowCache: { id: string; expires: number } | null = null

function apiKey() {
  const key = process.env.DIDIT_API_KEY?.trim()
  if (!key) throw new Error('DIDIT_API_KEY is not configured')
  return key
}

async function diditFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${DIDIT_API_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': apiKey(),
      Accept: 'application/json',
      ...init?.headers,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Didit ${response.status}: ${body.slice(0, 800)}`)
  }
  return response
}

export async function resolveDiditWorkflowId() {
  const configured = process.env.DIDIT_WORKFLOW_ID?.trim()
  if (configured) return configured
  if (workflowCache && workflowCache.expires > Date.now()) return workflowCache.id

  const response = await diditFetch('/workflows/')
  const payload = (await response.json()) as { results?: DiditWorkflow[] }
  const published = (payload.results ?? []).filter(
    (workflow) => workflow.workflow_type === 'kyc' && workflow.status === 'published',
  )
  const workflow = published.find((item) => item.is_default) ?? published[0]
  if (!workflow) throw new Error('No published Didit KYC workflow found')

  workflowCache = { id: workflow.workflow_id, expires: Date.now() + WORKFLOW_CACHE_MS }
  return workflow.workflow_id
}

export async function createDiditSession(input: {
  userId: string
  email: string
  appUrl?: string
}): Promise<DiditSession> {
  const workflowId = await resolveDiditWorkflowId()
  const callback = input.appUrl
    ? `${input.appUrl.replace(/\/+$/, '')}/profile/settings?kyc=return`
    : undefined

  const response = await diditFetch('/session/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow_id: workflowId,
      vendor_data: input.userId,
      language: 'uk',
      contact_details: {
        email: input.email,
        send_notification_emails: false,
      },
      metadata: { userId: input.userId, product: 'PFT.2' },
      ...(callback ? { callback, callback_method: 'both' } : {}),
    }),
  })

  const payload = (await response.json()) as Partial<DiditSession>
  if (!payload.session_id || !payload.url) throw new Error('Didit returned no session id or URL')
  return { session_id: payload.session_id, url: payload.url, status: payload.status ?? 'Not Started' }
}

export async function getDiditSessionStatus(sessionId: string) {
  const response = await diditFetch(`/session/${encodeURIComponent(sessionId)}/decision/`)
  const payload = (await response.json()) as { status?: string }
  return payload.status ?? null
}

export function mapDiditStatus(status: string | null | undefined) {
  switch (status) {
    case 'Approved':
      return 'APPROVED' as const
    case 'Declined':
      return 'REJECTED' as const
    case 'In Review':
    case 'In Progress':
    case 'Resubmitted':
    case 'Not Started':
    case 'Awaiting User':
      return 'PENDING' as const
    case 'Expired':
    case 'Abandoned':
    case 'Kyc Expired':
      return 'NOT_STARTED' as const
    default:
      return null
  }
}

function shortenFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortenFloats)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shortenFloats(entry)]),
    )
  }
  if (typeof value === 'number' && !Number.isInteger(value) && value % 1 === 0) return Math.trunc(value)
  return value
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }
  return value
}

function matches(secret: string, data: string, signature: string) {
  const expected = createHmac('sha256', secret).update(data, 'utf8').digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function headerCandidates(headers: Headers, name: string) {
  return [headers.get(name), headers.get(`${name}-previous`)].filter((value): value is string => Boolean(value))
}

/**
 * Verifies Didit's X-Signature-V2 (preferred), raw X-Signature, and the deprecated
 * envelope-only X-Signature-Simple. The timestamp window is five minutes.
 */
export function verifyDiditWebhook(rawBody: string, payload: unknown, headers: Headers) {
  const secret = process.env.DIDIT_WEBHOOK_SECRET?.trim()
  const timestamp = Number(headers.get('x-timestamp'))
  if (!secret || !Number.isFinite(timestamp)) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false

  const canonical = JSON.stringify(sortKeys(shortenFloats(payload)))
  const v2 = headerCandidates(headers, 'x-signature-v2')
  if (v2.some((signature) => matches(secret, canonical, signature))) return true

  const raw = headerCandidates(headers, 'x-signature')
  if (raw.some((signature) => matches(secret, rawBody, signature))) return true

  const record = payload as { session_id?: unknown; status?: unknown; webhook_type?: unknown }
  const simple = [
    String(timestamp),
    String(record.session_id ?? ''),
    String(record.status ?? ''),
    String(record.webhook_type ?? ''),
  ].join(':')
  const simpleSignatures = headerCandidates(headers, 'x-signature-simple')

  return simpleSignatures.some((signature) => matches(secret, simple, signature))
}
