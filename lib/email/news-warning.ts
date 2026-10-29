import { sendEmail, type EmailResult } from './resend'
import { escapeHtml, pftEmailShell } from './pft-email'

type NewsRiskWarning = {
  to: string
  name: string
  displayId: string
  eventTitle: string
  eventTime: Date
}

export async function sendNewsRiskWarning(input: NewsRiskWarning): Promise<EmailResult> {
  const time = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(input.eventTime)

  return sendEmail({
    to: input.to,
    subject: `News risk warning · ${input.displayId}`,
    idempotencyKey: `news-risk-${input.displayId}-${input.eventTime.toISOString()}`,
    text: [
      `Hi ${input.name},`,
      '',
      `You have open positions on ${input.displayId} while a high-impact event is approaching: ${input.eventTitle} at ${time} UTC.`,
      '',
      'Positions opened less than 60 minutes before the event and held through it are treated as news-window exposure. If you opened the position well before the event, this is a risk warning only.',
      '',
      'You can close or reduce positions at any time. New or increased positions are blocked during the ±5 minute window.',
      '',
      'PFT Risk',
    ].join('\n'),
    html: pftEmailShell({
      tone: 'pending',
      title: 'News risk warning',
      body: `<p style="margin:0;">Hi ${escapeHtml(input.name)}, you have open positions on <strong style="color:#f1f5f9;">${escapeHtml(input.displayId)}</strong> while a high-impact event is approaching:</p>
        <p style="margin:14px 0 0;padding:12px 14px;border-left:3px solid #f5b942;background:rgba(245,185,66,0.08);"><strong style="color:#f1f5f9;">${escapeHtml(input.eventTitle)}</strong><br/>${escapeHtml(time)} UTC</p>
        <p style="margin:14px 0 0;">Positions opened less than 60 minutes before the event and held through it are treated as news-window exposure. If you opened the position well before the event, this is a risk warning only.</p>
        <p style="margin:14px 0 0;">You can close or reduce positions at any time. New or increased positions are blocked during the ±5 minute window.</p>`,
      footer: 'PFT Risk',
    }),
  })
}
