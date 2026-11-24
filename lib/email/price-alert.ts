import { appUrl } from './account-credentials'
import { sendEmail, type EmailResult } from './resend'
import { emailRows, escapeHtml, pftEmailShell } from './pft-email'

export async function sendPriceAlert(input: {
  to: string
  name: string
  symbol: string
  direction: 'ABOVE' | 'BELOW'
  target: string
  actual: string
  alertId: string
}): Promise<EmailResult> {
  const directionWord = input.direction === 'ABOVE' ? 'above' : 'below'
  const subject = `Price alert · ${input.symbol} ${directionWord} ${input.target}`
  const ctaUrl = `${appUrl()}/dashboard/terminal`

  return sendEmail({
    to: input.to,
    subject,
    idempotencyKey: `price-alert-${input.alertId}`,
    text: [
      `Hi ${input.name},`,
      '',
      `The price of ${input.symbol} is now ${input.actual}, crossing your ${directionWord} ${input.target} alert.`,
      '',
      'You created this alert from the chart in your terminal. You will receive one email when the price crosses this level.',
      '',
      `Open terminal: ${ctaUrl}`,
      '',
      'PFT Terminal',
    ].join('\n'),
    html: pftEmailShell({
      tone: 'info',
      title: `Price alert · ${escapeHtml(input.symbol)} ${directionWord} ${escapeHtml(input.target)}`,
      body: `
        <p style="margin:0;">Hi ${escapeHtml(input.name)},</p>
        <p style="margin:14px 0 0;">The price of <strong style="color:#f1f5f9;">${escapeHtml(input.symbol)}</strong> is now <strong style="color:#f1f5f9;">${escapeHtml(input.actual)}</strong>, crossing your <strong style="color:#f1f5f9;">${directionWord} ${escapeHtml(input.target)}</strong> alert.</p>
        ${emailRows([
          ['Symbol', input.symbol],
          ['Condition', `${input.direction} ${input.target}`],
          ['Target', input.target],
          ['Price now', input.actual],
        ])}
        <p style="margin:14px 0 0;">You created this alert from the chart in your terminal. We will email you once when the price crosses this level.</p>
      `,
      cta: { label: 'Open terminal', url: ctaUrl },
      footer: `Alert ID: ${input.alertId}\n\nThis is an automated price alert from PFT Terminal.`,
    }),
  })
}
