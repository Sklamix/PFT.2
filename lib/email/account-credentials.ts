import { CHALLENGES } from '@/lib/challenges'
import { sendEmail, type EmailResult } from '@/lib/email/resend'
import { emailRows, escapeHtml, pftEmailShell } from '@/lib/email/pft-email'
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

const usd = (value: number) => `$${value.toLocaleString('en-US')}`

type Row = [string, string]

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

  const intro = `<p style="margin:0 0 16px;">Hi ${escapeHtml(details.fullName)}, payment for order <strong style="color:#f1f5f9;">${escapeHtml(details.providerOrderId)}</strong> is confirmed. Your account is live and ready to trade. ${details.access.setPassword ? 'Choose a password to sign in (the link is valid for 7 days).' : 'Sign in with your existing password.'}</p>`

  const standbyHtml = details.standby
    ? `<h2 style="margin:20px 0 4px;font-size:15px;color:#ffffff;">Frozen backup account</h2>
        <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;">Activates automatically if your primary account breaches.</p>
        ${emailRows(standby)}`
    : ''

  const html = pftEmailShell({
    tone: 'success',
    title: `Your ${escapeHtml(plan)} account is ready`,
    body: `${intro}
        <h2 style="margin:20px 0 8px;font-size:15px;color:#ffffff;">Account access</h2>
        ${emailRows(credentials)}
        <h2 style="margin:20px 0 8px;font-size:15px;color:#ffffff;">Objectives</h2>
        ${emailRows(objectives)}
        ${standbyHtml}`,
    cta: { label: cta, url: link },
    footer: `Sign in at ${appUrl()}/login with ${details.email}.\n\nButton not working? Copy this link into your browser:\n${link}\n\nForgot your password later? Use "Forgot your password" on the login page.`,
  })

  return { subject, html, text }
}

export function sendCredentialsEmail(details: CredentialsEmailDetails): Promise<EmailResult> {
  const { subject, html, text } = buildCredentialsEmail(details)
  return sendEmail({ to: details.email, subject, html, text })
}
