import { appUrl } from './account-credentials'
import { sendEmail, type EmailResult } from './resend'
import { escapeHtml, pftEmailShell } from './pft-email'
import { NO_ACQUIRED_RIGHT } from '@/lib/rules/version'

function rulesUrl() {
  return `${appUrl()}/rules`
}

function list(items: string[]) {
  return items.map((item) => `• ${item}`).join('\n')
}

function listHtml(items: string[]) {
  return `<ul style="margin:10px 0 0;padding-left:20px;">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
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
    html: pftEmailShell({
      tone: 'error',
      title: `Account closed · ${escapeHtml(input.displayId)}`,
      body: `<p style="margin:0;">Hi ${escapeHtml(input.name)}, account <strong style="color:#f1f5f9;">${escapeHtml(input.displayId)}</strong> has been closed for <strong style="color:#f1f5f9;">${escapeHtml(input.label)}</strong>.</p>
        <p style="margin:14px 0 0;"><strong>Reason:</strong> ${escapeHtml(input.reason)}</p>
        <p style="margin:14px 0 0;"><strong>What happens now:</strong></p>${listHtml(consequences)}
        <p style="margin:14px 0 0;">${escapeHtml(appeal)}</p>`,
      footer: `${NO_ACQUIRED_RIGHT}\n\nFull rules: ${rulesUrl()}`,
    }),
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
    html: pftEmailShell({
      tone: 'pending',
      title: `Rule violation warning · ${escapeHtml(input.displayId)}`,
      body: `<p style="margin:0;">Hi ${escapeHtml(input.name)}, account <strong style="color:#f1f5f9;">${escapeHtml(input.displayId)}</strong> recorded a <strong style="color:#f1f5f9;">${escapeHtml(input.label)}</strong>.</p>
        <p style="margin:14px 0 0;"><strong>Details:</strong> ${escapeHtml(input.reason)}</p>
        <p style="margin:14px 0 0;"><strong>Applied now:</strong></p>${listHtml(input.consequences.length > 0 ? input.consequences : ['A formal warning was added to your account record.'])}
        <p style="margin:14px 0 0;">${escapeHtml(input.nextViolation)}</p>`,
      footer: `${NO_ACQUIRED_RIGHT}\n\nFull rules: ${rulesUrl()}`,
    }),
  })
}
