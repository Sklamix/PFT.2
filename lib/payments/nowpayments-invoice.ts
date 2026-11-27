import { appUrl } from '@/lib/email/account-credentials'

/**
 * Single place that talks to NOWPayments invoice API.
 *
 * `orderId` is the provider-facing order reference. Reusing the same value when an
 * invoice is reissued keeps the IPN webhook pointed at the same Order row, so a
 * retry can never provision a second account.
 */
export const PAY_CURRENCY = 'usdttrc20'
const INVOICE_TIMEOUT_MS = 15_000

export type InvoiceRequest = {
  orderId: string
  amount: number
  description: string
  email: string
}

export type InvoiceOutcome =
  | { ok: true; url: string; providerInvoiceId: string | null }
  | { ok: false; error: string }

type NowPaymentsInvoice = {
  id?: string | number
  invoice_url?: string
  message?: string
}

export async function createNowPaymentsInvoice(input: InvoiceRequest): Promise<InvoiceOutcome> {
  const apiKey = process.env.NOWPAYMENTS_API_KEY
  if (!apiKey) {
    console.error('Checkout misconfigured: NOWPAYMENTS_API_KEY is not set')
    return { ok: false, error: 'Crypto checkout is temporarily unavailable.' }
  }

  const baseUrl = appUrl()
  const payload = {
    price_amount: Number(input.amount.toFixed(2)),
    price_currency: 'usd',
    pay_currency: PAY_CURRENCY,
    order_id: input.orderId,
    order_description: input.description,
    ipn_callback_url: `${baseUrl}/api/webhooks/payment-success`,
    success_url: `${baseUrl}/dashboard/terminal`,
    cancel_url: `${baseUrl}/dashboard/terminal`,
    customer_email: input.email,
  }

  try {
    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(INVOICE_TIMEOUT_MS),
    })
    const data = (await response.json().catch(() => null)) as NowPaymentsInvoice | null
    const invoiceUrl = data?.invoice_url
    if (!response.ok || typeof invoiceUrl !== 'string' || !invoiceUrl.startsWith('https://')) {
      console.error('NOWPayments invoice error:', response.status, data)
      return { ok: false, error: data?.message || 'Unable to generate a payment invoice.' }
    }
    return {
      ok: true,
      url: invoiceUrl,
      providerInvoiceId: data?.id != null ? String(data.id) : null,
    }
  } catch (error) {
    console.error('NOWPayments invoice request failed', error)
    return { ok: false, error: 'Unable to generate a payment invoice.' }
  }
}
