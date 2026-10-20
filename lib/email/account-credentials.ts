import { CHALLENGES } from '@/lib/challenges'
import { sendEmail, type EmailResult } from '@/lib/email/resend'
import type { ProvisionResult } from '@/lib/provisioning/challenge-account'

const DEFAULT_APP_URL = 'https://pft-app-prod.vercel.app'

export function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '')
}

export interface CredentialsEmailDetails extends ProvisionResult {
  providerOrderId: string
  email: string
  fullName: string
  /** One-time set-password link for new traders, or the login page for traders who already have a password. */
  access: { url: string; setPassword: boolean }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const usd = (value: number) => `$${value.toLocaleString('en-US')}`

type Row = [string, string]

function table(rows: Row[]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-top:1px solid #1f2937;">
${rows
  .map(
    ([label, value]) =>
      `<tr><td style="padding:10px 0;color:#9ca3af;border-bottom:1px solid #1f2937;">${escapeHtml(label)}</td><td style="padding:10px 0;text-align:right;color:#ffffff;border-bottom:1px solid #1f2937;font-family:Menlo,Consolas,monospace;">${escapeHtml(value)}</td></tr>`,
  )
  .join('\n')}
</table>`
}

export function buildCredentialsEmail(details: CredentialsEmailDetails) {
  const rules = CHALLENGES[details.plan.challengeType]
  const plan = `${Math.round(details.plan.planSize / 1000)}k ${details.plan.challengeType === 'one-step' ? '1-Step' : '2-Step'} Challenge`
  const link = details.access.url
  const cta = details.access.setPassword ? 'Set your password' : 'Log in to your terminal'

  const credentials: Row[] = [
    ['Login email', details.email],
    ['Account ID', details.primary.displayId],
    ['Account login', details.primary.mt5Login],
    ['Server', details.primary.mt5Server],
    ['Starting balance', usd(details.plan.planSize)],
    ['Leverage', '1:100'],
  ]
  const objectives: Row[] = [
    ['Profit target (Phase 1)', `${rules.phase1Target}%`],
    ...(rules.phase2Target !== null ? ([['Profit target (Phase 2)', `${rules.phase2Target}%`]] as Row[]) : []),
    ['Max daily loss', `${rules.dailyDrawdown}%`],
    ['Max drawdown', `${rules.overallDrawdown}% (${details.plan.drawdownMode})`],
    ['Min trading days', String(rules.minTradingDays)],
  ]
  const standby: Row[] = details.standby
    ? [
        ['Standby account ID', details.standby.displayId],
        ['Standby login', details.standby.mt5Login],
      ]
    : []

  const subject = `Your ${plan} account is ready — ${details.primary.displayId}`

  const text = [
    `Hi ${details.fullName},`,
    '',
    `Payment for order ${details.providerOrderId} is confirmed and your ${plan} account is live.`,
    '',
    details.access.setPassword
      ? 'Set your password (link valid for 7 days), then sign in with this email to open your terminal:'
      : 'Sign in with your existing password to open your terminal:',
    link,
    '',
    ...credentials.map(([label, value]) => `${label}: ${value}`),
    '',
    'Objectives:',
    ...objectives.map(([label, value]) => `${label}: ${value}`),
    ...(details.standby
      ? [
          '',
          'Frozen backup account (activates automatically if your primary account breaches):',
          ...standby.map(([label, value]) => `${label}: ${value}`),
        ]
      : []),
    '',
    'Forgot your password later? Use "Forgot your password" on the login page.',
  ].join('\n')

  const url = escapeHtml(link)
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b0f17;font-family:Arial,Helvetica,sans-serif;color:#e5e7eb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#111827;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 12px;font-size:20px;color:#ffffff;">Your ${escapeHtml(plan)} account is ready</h1>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">Hi ${escapeHtml(details.fullName)}, payment for order <strong>${escapeHtml(details.providerOrderId)}</strong> is confirmed. Your account is live and ready to trade. ${details.access.setPassword ? 'Choose a password to sign in (the link is valid for 7 days).' : 'Sign in with your existing password.'}</p>
        <p style="margin:0 0 24px;"><a href="${url}" style="display:inline-block;padding:12px 22px;background:#10b981;color:#04110b;text-decoration:none;font-weight:bold;border-radius:8px;">${cta}</a></p>
      </td></tr>
      <tr><td style="padding:0 28px;">
        <h2 style="margin:0 0 8px;font-size:15px;color:#ffffff;">Account access</h2>
        ${table(credentials)}
        <h2 style="margin:20px 0 8px;font-size:15px;color:#ffffff;">Objectives</h2>
        ${table(objectives)}
        ${
          details.standby
            ? `<h2 style="margin:20px 0 4px;font-size:15px;color:#ffffff;">Frozen backup account</h2>
        <p style="margin:0 0 8px;font-size:12px;color:#9ca3af;">Activates automatically if your primary account breaches.</p>
        ${table(standby)}`
            : ''
        }
      </td></tr>
      <tr><td style="padding:20px 28px 28px;font-size:12px;line-height:1.6;color:#9ca3af;">
        <p style="margin:0 0 8px;">Button not working? Copy this link into your browser:<br><a href="${url}" style="color:#34d399;word-break:break-all;">${url}</a></p>
        <p style="margin:0;">Sign in at ${escapeHtml(`${appUrl()}/login`)} with ${escapeHtml(details.email)}. Forgot your password later? Use "Forgot your password" on the login page.</p>
      </td></tr>
    </table>
  </body>
</html>`

  return { subject, html, text }
}

export function sendCredentialsEmail(details: CredentialsEmailDetails): Promise<EmailResult> {
  const { subject, html, text } = buildCredentialsEmail(details)
  return sendEmail({ to: details.email, subject, html, text })
}
