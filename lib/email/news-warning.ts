import { sendEmail, type EmailResult } from './resend'

type NewsRiskWarning = {
  to: string
  name: string
  displayId: string
  eventTitle: string
  eventTime: Date
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
        <p>Hi ${escapeHtml(input.name)},</p>
        <p>You have open positions on <strong>${escapeHtml(input.displayId)}</strong> while a high-impact event is approaching:</p>
        <p><strong>${escapeHtml(input.eventTitle)}</strong><br/>${escapeHtml(time)} UTC</p>
        <p>Positions opened less than 60 minutes before the event and held through it are treated as news-window exposure. If you opened the position well before the event, this is a risk warning only.</p>
        <p>You can close or reduce positions at any time. New or increased positions are blocked during the ±5 minute window.</p>
        <p>PFT Risk</p>
      </div>
    `,
  })
}
