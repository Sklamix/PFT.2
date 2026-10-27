import { appUrl } from './account-credentials'
import { sendEmail, type EmailResult } from './resend'
import { NO_ACQUIRED_RIGHT } from '@/lib/rules/version'

function rulesUrl() {
  return `${appUrl()}/rules`
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function list(items: string[]) {
  return items.map((item) => `• ${item}`).join('\n')
}

type BreachNotice = {
  to: string
  name: string
  displayId: string
  label: string
  reason: string
  consequences: string[]
  appealWindowDays: number
  /** Reference used for the Resend idempotency key so a retry cannot double-send. */
  reference: string
}

export async function sendBreachNotice(input: BreachNotice): Promise<EmailResult> {
  const appeal =
    input.appealWindowDays > 0
      ? `You can appeal this decision from your terminal within ${input.appealWindowDays} days. An admin who did not close the account reviews every appeal.`
      : 'This breach type is not appealable.'
  const consequences = input.consequences.length > 0 ? input.consequences : ['Trading on this account is closed.']

  return sendEmail({
    to: input.to,
    subject: `Account closed · ${input.displayId} · ${input.label}`,
    idempotencyKey: `breach-${input.reference}`,
    text: [
      `Hi ${input.name},`,
      '',
      `Account ${input.displayId} has been closed for ${input.label}.`,
      '',
      `Reason: ${input.reason}`,
      '',
      'What happens now:',
      list(consequences),
      '',
      appeal,
      '',
      NO_ACQUIRED_RIGHT,
      '',
      `Full rules: ${rulesUrl()}`,
      '',
      'PFT Risk',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
        <p>Hi ${escapeHtml(input.name)},</p>
        <p>Account <strong>${escapeHtml(input.displayId)}</strong> has been closed for <strong>${escapeHtml(input.label)}</strong>.</p>
        <p><strong>Reason:</strong> ${escapeHtml(input.reason)}</p>
        <p><strong>What happens now:</strong></p>
        <ul>${consequences.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        <p>${escapeHtml(appeal)}</p>
        <p>PFT Risk</p>
      </div>
    `,
  })
}

type SoftBreachNotice = {
  to: string
  name: string
  displayId: string
  label: string
  reason: string
  consequences: string[]
  /** Set when a further violation closes the account. */
  nextViolation: string
  reference: string
}

export async function sendSoftBreachNotice(input: SoftBreachNotice): Promise<EmailResult> {
  return sendEmail({
    to: input.to,
    subject: `Rule violation warning · ${input.displayId} · ${input.label}`,
    idempotencyKey: `soft-breach-${input.reference}`,
    text: [
      `Hi ${input.name},`,
      '',
      `Account ${input.displayId} recorded a ${input.label}.`,
      '',
      `Details: ${input.reason}`,
      '',
      'Applied now:',
      list(input.consequences.length > 0 ? input.consequences : ['A formal warning was added to your account record.']),
      '',
      input.nextViolation,
      '',
      NO_ACQUIRED_RIGHT,
      '',
      'Full rules: ' + rulesUrl(),
      '',
      'PFT Risk',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
        <p>Hi ${escapeHtml(input.name)},</p>
        <p>Account <strong>${escapeHtml(input.displayId)}</strong> recorded a <strong>${escapeHtml(input.label)}</strong>.</p>
        <p><strong>Details:</strong> ${escapeHtml(input.reason)}</p>
        <p><strong>Applied now:</strong></p>
        <ul>${(input.consequences.length > 0 ? input.consequences : ['A formal warning was added to your account record.'])
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join('')}</ul>
        <p>${escapeHtml(input.nextViolation)}</p>
        <p>PFT Risk</p>
      </div>
    `,
  })
}
