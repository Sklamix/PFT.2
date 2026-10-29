import { sendEmail, type EmailResult } from './resend'
import { escapeHtml, pftEmailShell } from './pft-email'

type InactivityInput = {
  to: string
  name: string
  displayId: string
  days: number
}

export async function sendInactivityWarning(input: InactivityInput): Promise<EmailResult> {
  const subject = `Inactivity warning · ${input.displayId}`
  const text = [
    `Hi ${input.name},`,
    '',
    `Your account ${input.displayId} has had no closed trades for ${input.days} days.`,
    '',
    'Please place and close at least one trade to keep the account active. Accounts with no closed trades for 90 days may be closed without a refund.',
    '',
    'PFT Risk',
  ].join('\n')

  return sendEmail({
    to: input.to,
    subject,
    idempotencyKey: `inactivity-warning-${input.displayId}-${input.days}`,
    text,
    html: pftEmailShell({
      tone: 'pending',
      title: 'Inactivity warning',
      body: `<p style="margin:0;">Hi ${escapeHtml(input.name)}, your account <strong style="color:#f1f5f9;">${escapeHtml(input.displayId)}</strong> has had no closed trades for <strong style="color:#f1f5f9;">${input.days} days</strong>.</p>
        <p style="margin:14px 0 0;">Please place and close at least one trade to keep the account active. Accounts with no closed trades for 90 days may be closed without a refund.</p>`,
      footer: 'PFT Risk',
    }),
  })
}

export async function sendInactivityClosed(input: InactivityInput): Promise<EmailResult> {
  const subject = `Account closed for inactivity · ${input.displayId}`
  const text = [
    `Hi ${input.name},`,
    '',
    `Your account ${input.displayId} has been closed after ${input.days} days without a closed trade.`,
    '',
    'The evaluation fee is non-refundable. You can purchase a new evaluation if you want to continue.',
    '',
    'PFT Risk',
  ].join('\n')

  return sendEmail({
    to: input.to,
    subject,
    idempotencyKey: `inactivity-closed-${input.displayId}`,
    text,
    html: pftEmailShell({
      tone: 'error',
      title: 'Account closed for inactivity',
      body: `<p style="margin:0;">Hi ${escapeHtml(input.name)}, your account <strong style="color:#f1f5f9;">${escapeHtml(input.displayId)}</strong> has been closed after <strong style="color:#f1f5f9;">${input.days} days</strong> without a closed trade.</p>
        <p style="margin:14px 0 0;">The evaluation fee is non-refundable. You can purchase a new evaluation if you want to continue.</p>`,
      footer: 'PFT Risk',
    }),
  })
}
