import { sendEmail, type EmailResult } from './resend'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

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
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
        <p>Hi ${escapeHtml(input.name)},</p>
        <p>Your account <strong>${escapeHtml(input.displayId)}</strong> has had no closed trades for <strong>${input.days} days</strong>.</p>
        <p>Please place and close at least one trade to keep the account active. Accounts with no closed trades for 90 days may be closed without a refund.</p>
        <p>PFT Risk</p>
      </div>
    `,
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
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
        <p>Hi ${escapeHtml(input.name)},</p>
        <p>Your account <strong>${escapeHtml(input.displayId)}</strong> has been closed after <strong>${input.days} days</strong> without a closed trade.</p>
        <p>The evaluation fee is non-refundable. You can purchase a new evaluation if you want to continue.</p>
        <p>PFT Risk</p>
      </div>
    `,
  })
}
