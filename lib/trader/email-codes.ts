import { createHmac, randomInt } from 'crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email/resend'

/**
 * Single-use email codes. The code itself is never stored: only an HMAC over
 * `purpose:email:code`, so a REGISTER, LOGIN or STEP_UP code cannot be replayed
 * as another purpose even though rows share the email key.
 */
export type EmailCodePurpose = 'REGISTER' | 'LOGIN' | 'STEP_UP'

export const EMAIL_CODE_TTL_MS = 10 * 60_000
export const EMAIL_CODE_RESEND_INTERVAL_MS = 60_000

export function emailCodeHash(email: string, code: string, purpose: EmailCodePurpose) {
  const secret = process.env.TRADER_SESSION_SECRET
  if (!secret || secret.length < 16) throw new Error('TRADER_SESSION_SECRET is required to issue email login codes')
  return createHmac('sha256', secret).update(`${purpose}:${email}:${code}`).digest('hex')
}

export type IssueEmailCodeResult = { ok: true } | { ok: false; reason: 'resend_throttled' | 'send_failed'; retryAfterSec?: number }

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

/** Generates a STEP_UP code for an already-authenticated user's own email. */
export async function issueStepUpEmailCode(email: string): Promise<IssueEmailCodeResult> {
  const now = new Date()
  const existing = await prisma.emailLoginCode.findUnique({ where: { email } })
  if (existing && now.getTime() - existing.sentAt.getTime() < EMAIL_CODE_RESEND_INTERVAL_MS) {
    return { ok: false, reason: 'resend_throttled', retryAfterSec: Math.ceil((EMAIL_CODE_RESEND_INTERVAL_MS - (now.getTime() - existing.sentAt.getTime())) / 1000) }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hashedCode = emailCodeHash(email, code, 'STEP_UP')
  await prisma.emailLoginCode.upsert({
    where: { email },
    create: { email, codeHash: hashedCode, expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS), sentAt: now, attempts: 0 },
    update: { codeHash: hashedCode, expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS), sentAt: now, attempts: 0 },
  })

  const result = await sendEmail({
    to: email,
    subject: 'Your PFT verification code',
    text: `Your PFT verification code: ${code}. Use it to confirm this request. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;background:#090D16;color:#f8fafc;padding:32px"><p>Use this code to confirm your PFT account request:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#a3e635">${code}</p><p>This code expires in 10 minutes and was requested for ${escapeHtml(email)}.</p></div>`,
    idempotencyKey: `pft-step-up-code-${hashedCode}`,
  })
  if (result.status !== 'SENT') {
    await prisma.emailLoginCode.deleteMany({ where: { email, codeHash: hashedCode } })
    return { ok: false, reason: 'send_failed' }
  }
  return { ok: true }
}
