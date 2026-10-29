import { sendEmail, type EmailResult } from '@/lib/email/resend'
import { emailRows, escapeHtml, pftEmailShell } from '@/lib/email/pft-email'

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
    'Your PFT terminal credentials will be sent to this address once the payment is confirmed.',
    'If you have already paid, you can ignore this email.',
  ].join('\n')

  const html = pftEmailShell({
    tone: 'pending',
    title: 'Complete your challenge payment',
    body: `<p style="margin:0 0 16px;">Hi ${escapeHtml(details.fullName)}, your order is created and waiting for payment. If you closed the payment window, use the button below to return to your invoice.</p>${emailRows(rows)}`,
    cta: { label: `Pay ${usd(details.totalAmount)} now`, url: details.invoiceUrl },
    footer: `Your PFT terminal credentials will be sent to this address once the payment is confirmed.\n\nButton not working? Copy this link into your browser:\n${details.invoiceUrl}\n\nIf you have already paid, you can ignore this email.`,
  })

  return { subject, html, text }
}

export function sendCheckoutInvoiceEmail(details: CheckoutInvoiceDetails): Promise<EmailResult> {
  const { subject, html, text } = buildCheckoutInvoiceEmail(details)
  return sendEmail({ to: details.email, subject, html, text, idempotencyKey: `checkout-invoice/${details.orderId}` })
}
