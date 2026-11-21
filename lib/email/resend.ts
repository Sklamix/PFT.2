const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 8_000
const DEFAULT_FROM = 'PFT Challenges <onboarding@resend.dev>'

/**
 * Production-like runtimes (deployed build or Vercel production scope). In these
 * environments the Resend sandbox sender is NOT acceptable: Resend restricts it
 * to the account owner's own address and rejects every other recipient with
 * HTTP 422, so real users would silently lose their email.
 */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
}

/**
 * Sender resolution:
 *  - DEV (and tests): RESEND_FROM_EMAIL, or the Resend sandbox sender as a
 *    local-development fallback (fine for Mailpit and sandbox accounts).
 *  - Production-like runtimes: RESEND_FROM_EMAIL must be configured and
 *    non-empty. Otherwise sending FAILS CLOSED instead of silently using the
 *    sandbox sender that cannot reach real recipients.
 */
function resolveSender(): { ok: true; from: string } | { ok: false; error: string } {
  const configured = (process.env.RESEND_FROM_EMAIL ?? '').trim()
  if (configured) return { ok: true, from: configured }
  if (isProductionRuntime()) {
    return {
      ok: false,
      error:
        'RESEND_FROM_EMAIL is not configured for a production runtime: refusing to send from the Resend sandbox sender (onboarding@resend.dev), which cannot deliver to real recipients',
    }
  }
  return { ok: true, from: DEFAULT_FROM }
}

/**
 * Human-readable classification for Resend API failures. Server-side detail is
 * kept (it never contains message bodies or recipients), plus an actionable
 * hint for the most common configuration causes.
 */
function classifyResendFailure(status: number, message: string | undefined): string {
  const detail = message ?? 'unknown error'
  if (status === 422) {
    return `${detail} (resend ${status}: sandbox/testing restriction — verify a sending domain in Resend and configure RESEND_FROM_EMAIL with a sender on that domain using a non-sandbox API key)`
  }
  if (status === 401 || status === 403) {
    return `${detail} (resend ${status}: API key rejected — check that RESEND_API_KEY is valid for this environment)`
  }
  return `Resend ${status}: ${detail}`
}

/**
 * DEV-only Mailpit transport.
 *
 * Active ONLY when ALL of the following hold:
 *  - NODE_ENV is exactly 'development';
 *  - DEV_EMAIL_API_URL is explicitly set (opt-in);
 *  - the URL points at a loopback host (localhost / 127.x / ::1) over http(s).
 *
 * In any other environment the DEV variable is ignored — except in production,
 * where its mere presence is a configuration error and sendEmail() fails
 * closed (throws) instead of silently falling back to another transport.
 */
const DEV_EMAIL_API_URL_ENV = 'DEV_EMAIL_API_URL'

function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

function devTransportTarget(): { mode: 'resend' } | { mode: 'mailpit'; apiRoot: string } | { mode: 'fail-closed'; error: string } {
  const configured = process.env[DEV_EMAIL_API_URL_ENV]
  if (!configured) return { mode: 'resend' }
  if (process.env.NODE_ENV === 'production') {
    return { mode: 'fail-closed', error: `${DEV_EMAIL_API_URL_ENV} is set in a production environment` }
  }
  if (process.env.NODE_ENV !== 'development') {
    // Any other non-dev runtime (e.g. tests, custom runtimes) stays on Resend.
    return { mode: 'resend' }
  }
  if (!isLoopbackUrl(configured)) {
    return { mode: 'fail-closed', error: `${DEV_EMAIL_API_URL_ENV} must be a loopback http(s) URL` }
  }
  return { mode: 'mailpit', apiRoot: configured.replace(/\/+$/, '') }
}

/**
 * Parses a Resend-style "Name <email>" or bare "email" sender string into the
 * Mailpit SendRequest `From` shape `{ Name?, Email }`. Returns null when the
 * address cannot be reliably parsed so the caller can fail without sending.
 */
function parseFromAddress(raw: string): { name?: string; email: string } | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const angled = /^(.*?)\s*<([^>]+)>$/.exec(trimmed)
  if (angled) {
    const name = angled[1].trim()
    const email = angled[2].trim()
    if (!email) return null
    return name ? { name, email } : { email }
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { email: trimmed }
  return null
}

/** Sends a message to a local Mailpit instance via its HTTP send API. */
async function sendViaMailpit(apiRoot: string, message: EmailMessage): Promise<EmailResult> {
  const from = parseFromAddress(process.env.RESEND_FROM_EMAIL || DEFAULT_FROM)
  if (!from) {
    return { status: 'FAILED', error: 'Mailpit transport: invalid sender address' }
  }
  try {
    const response = await fetch(`${apiRoot}/api/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        From: from.name ? { Name: from.name, Email: from.email } : { Email: from.email },
        To: [message.to].map((email) => ({ Email: email })),
        Subject: message.subject,
        HTML: message.html,
        Text: message.text,
        ...(message.idempotencyKey ? { Tags: [message.idempotencyKey] } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const data = (await response.json().catch(() => null)) as { ID?: string } | null
    if (!response.ok || !data?.ID) {
      return { status: 'FAILED', error: `Mailpit ${response.status}: unexpected response` }
    }
    return { status: 'SENT', id: data.ID }
  } catch (error) {
    return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
  }
}

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  idempotencyKey?: string
}

export type EmailResult =
  | { status: 'SENT'; id: string }
  | { status: 'SKIPPED'; error: string }
  | { status: 'FAILED'; error: string }

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY)
}

/**
 * Whether the DEV-only Mailpit transport is active for this runtime.
 *
 * True only when devTransportTarget() resolves to `mailpit` — i.e. NODE_ENV is
 * 'development', DEV_EMAIL_API_URL is set, and it is a valid loopback URL. Used
 * by callers (e.g. the email-code route) to decide whether a real Resend API
 * key is required.
 */
export function isDevMailpitActive(): boolean {
  return devTransportTarget().mode === 'mailpit'
}

/** Sends an email through the Resend REST API (or DEV Mailpit when opted in). Never throws in DEV. */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const target = devTransportTarget()
  if (target.mode === 'fail-closed') {
    // Configuration error: refuse to send rather than silently switching transports.
    throw new Error(`Email transport misconfigured: ${target.error}`)
  }
  if (target.mode === 'mailpit') return sendViaMailpit(target.apiRoot, message)

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return { status: 'SKIPPED', error: 'RESEND_API_KEY is not configured' }

  const sender = resolveSender()
  if (!sender.ok) {
    console.error(`[pft email] send refused: ${sender.error}`)
    return { status: 'FAILED', error: sender.error }
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: sender.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    const data = (await response.json().catch(() => null)) as { id?: string; message?: string } | null
    if (!response.ok || !data?.id) {
      return { status: 'FAILED', error: classifyResendFailure(response.status, data?.message) }
    }
    return { status: 'SENT', id: data.id }
  } catch (error) {
    return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
  }
}
