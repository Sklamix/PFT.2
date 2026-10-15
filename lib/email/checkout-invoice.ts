import { sendEmail, type EmailResult } from '@/lib/email/resend'

export interface CheckoutInvoiceDetails {
  orderId: string
  email: string
  fullName: string
  invoiceUrl: string
  planSize: number
  evaluationLabel: string
  drawdownMode: 'static' | 'trailing'
  hasFrozenBackup: boolean
  basePrice: number
  frozenBackupPrice: number
  totalAmount: number
  payCurrencyLabel: string
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const usd = (value: number) => `$${value.toFixed(2)}`

export function buildCheckoutInvoiceEmail(details: CheckoutInvoiceDetails) {
  const plan = `${details.planSize / 1000}k ${details.evaluationLabel} Challenge`
  const rows: [string, string][] = [
    ['Order ID', details.orderId],
    ['Challenge', plan],
    ['Drawdown', details.drawdownMode === 'static' ? 'Static' : 'Trailing'],
    ['Challenge fee', usd(details.basePrice)],
    ...(details.hasFrozenBackup ? ([['Frozen backup account', usd(details.frozenBackupPrice)]] as [string, string][]) : []),
    ['Total', usd(details.totalAmount)],
    ['Pay with', details.payCurrencyLabel],
  ]

  const subject = `Complete your payment — ${plan} (${details.orderId})`

  const text = [
    `Hi ${details.fullName},`,
    '',
    'Your challenge order has been created and is waiting for payment.',
    'If you closed the payment window, you can finish paying here:',
    details.invoiceUrl,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Your MT5 credentials will be sent to this address once the payment is confirmed.',
    'If you have already paid, you can ignore this email.',
  ].join('\n')

  const url = escapeHtml(details.invoiceUrl)
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b0f17;font-family:Arial,Helvetica,sans-serif;color:#e5e7eb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#111827;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 12px;font-size:20px;color:#ffffff;">Complete your challenge payment</h1>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">Hi ${escapeHtml(details.fullName)}, your order is created and waiting for payment. If you closed the payment window, use the button below to return to your invoice.</p>
        <p style="margin:0 0 24px;"><a href="${url}" style="display:inline-block;padding:12px 22px;background:#10b981;color:#04110b;text-decoration:none;font-weight:bold;border-radius:8px;">Pay ${usd(details.totalAmount)} now</a></p>
      </td></tr>
      <tr><td style="padding:0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-top:1px solid #1f2937;">
          ${rows
            .map(
              ([label, value]) =>
                `<tr><td style="padding:10px 0;color:#9ca3af;border-bottom:1px solid #1f2937;">${escapeHtml(label)}</td><td style="padding:10px 0;text-align:right;color:#ffffff;border-bottom:1px solid #1f2937;">${escapeHtml(value)}</td></tr>`,
            )
            .join('\n          ')}
        </table>
      </td></tr>
      <tr><td style="padding:20px 28px 28px;font-size:12px;line-height:1.6;color:#9ca3af;">
        <p style="margin:0 0 8px;">Button not working? Copy this link into your browser:<br><a href="${url}" style="color:#34d399;word-break:break-all;">${url}</a></p>
        <p style="margin:0;">Your MT5 credentials will be sent to this address once the payment is confirmed. If you have already paid, you can ignore this email.</p>
      </td></tr>
    </table>
  </body>
</html>`

  return { subject, html, text }
}

export function sendCheckoutInvoiceEmail(details: CheckoutInvoiceDetails): Promise<EmailResult> {
  const { subject, html, text } = buildCheckoutInvoiceEmail(details)
  return sendEmail({ to: details.email, subject, html, text, idempotencyKey: `checkout-invoice/${details.orderId}` })
}
