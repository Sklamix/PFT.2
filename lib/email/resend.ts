const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 8_000
const DEFAULT_FROM = 'PFT Challenges <onboarding@resend.dev>'

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

/** Sends an email through the Resend REST API. Never throws. */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return { status: 'SKIPPED', error: 'RESEND_API_KEY is not configured' }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    const data = (await response.json().catch(() => null)) as { id?: string; message?: string } | null
    if (!response.ok || !data?.id) {
      return { status: 'FAILED', error: `Resend ${response.status}: ${data?.message ?? 'unknown error'}` }
    }
    return { status: 'SENT', id: data.id }
  } catch (error) {
    return { status: 'FAILED', error: error instanceof Error ? error.message : String(error) }
  }
}
