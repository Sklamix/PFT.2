const INVOICE_ENDPOINT = 'https://api.nowpayments.io/v1/invoice'
const INVOICE_TIMEOUT_MS = 15_000

export const PAY_CURRENCY = 'usdttrc20'
export const PAY_CURRENCY_LABEL = 'USDT (TRC20)'

export interface NowPaymentsInvoice {
  id?: string | number
  invoice_url?: string
  message?: string
}

export type InvoiceResult =
  | { ok: true; invoiceUrl: string; providerInvoiceId: string | null }
  | { ok: false; error: string }

export type InvoiceInput = {
  amount: number
  orderId: string
  description: string
  callbackUrl: string
  successUrl: string
  cancelUrl: string
  customerEmail: string
}

/** Creates a hosted NOWPayments invoice. Never throws; callers map failures to 503/400. */
export async function createInvoice(input: InvoiceInput): Promise<InvoiceResult> {
  const apiKey = process.env.NOWPAYMENTS_API_KEY
  if (!apiKey) {
    console.error('Checkout misconfigured: NOWPAYMENTS_API_KEY is not set')
    return { ok: false, error: 'Crypto checkout is temporarily unavailable.' }
  }

  try {
    const response = await fetch(INVOICE_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: input.amount,
        price_currency: 'usd',
        pay_currency: PAY_CURRENCY,
        order_id: input.orderId,
        order_description: input.description,
        ipn_callback_url: input.callbackUrl,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        customer_email: input.customerEmail,
      }),
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
      invoiceUrl,
      providerInvoiceId: data?.id != null ? String(data.id) : null,
    }
  } catch (error) {
    console.error('NOWPayments invoice request failed:', error)
    return { ok: false, error: 'Unable to generate a payment invoice.' }
  }
}
