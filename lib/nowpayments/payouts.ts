import type { NowPaymentsPayoutConfig } from '@/lib/nowpayments/config'

const API_URL = 'https://api.nowpayments.io/v1'
const REQUEST_TIMEOUT_MS = 15_000

export type NowPaymentsWithdrawal = {
  payoutId: string
  address: string
  currency: string
  amount: string
}

export type CreatedNowPaymentsPayout = {
  batchId: string
  withdrawals: Array<{
    payoutId: string
    withdrawalId: string
    status: string
  }>
}

export type NowPaymentsPayoutStatus = {
  withdrawalId: string
  status: string
  hash: string | null
  error: string | null
}

export class NowPaymentsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function providerMessage(body: unknown) {
  if (!body || typeof body !== 'object') return null
  const data = body as Record<string, unknown>
  if (typeof data.message === 'string') return data.message
  if (typeof data.error === 'string') return data.error
  return null
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

export async function authenticateNowPayments(config: NowPaymentsPayoutConfig) {
  const response = await fetch(`${API_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await readJson(response)
  const token =
    body && typeof body === 'object' && 'token' in body && typeof body.token === 'string'
      ? body.token
      : null
  if (!response.ok || !token) {
    throw new NowPaymentsApiError(
      providerMessage(body) ?? 'NOWPayments authentication failed.',
      response.status,
    )
  }
  return token
}

export async function createNowPaymentsPayout(
  config: NowPaymentsPayoutConfig,
  token: string,
  withdrawals: NowPaymentsWithdrawal[],
): Promise<CreatedNowPaymentsPayout> {
  const response = await fetch(`${API_URL}/payout`, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      withdrawals: withdrawals.map((withdrawal) => ({
        address: withdrawal.address,
        currency: withdrawal.currency,
        amount: withdrawal.amount,
        unique_external_id: withdrawal.payoutId,
      })),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new NowPaymentsApiError(
      providerMessage(body) ?? 'NOWPayments rejected the payout request.',
      response.status,
    )
  }

  const data = body as {
    id?: string | number
    withdrawals?: Array<{
      id?: string | number
      unique_external_id?: string
      status?: string
    }>
  } | null
  const batchId = data?.id == null ? null : String(data.id)
  const created = data?.withdrawals
  if (!batchId || !Array.isArray(created)) {
    throw new Error('NOWPayments returned an incomplete payout response.')
  }

  const result = created.map((withdrawal) => ({
    payoutId: withdrawal.unique_external_id ?? '',
    withdrawalId: withdrawal.id == null ? '' : String(withdrawal.id),
    status: withdrawal.status ?? 'WAITING',
  }))
  if (result.length !== withdrawals.length || result.some((item) => !item.payoutId || !item.withdrawalId)) {
    throw new Error('NOWPayments returned incomplete withdrawal identifiers.')
  }
  const requestedIds = new Set(withdrawals.map((withdrawal) => withdrawal.payoutId))
  const responseIds = new Set(result.map((item) => item.payoutId))
  if (
    responseIds.size !== result.length ||
    result.some((item) => !requestedIds.has(item.payoutId)) ||
    responseIds.size !== requestedIds.size
  ) {
    throw new Error('NOWPayments returned an unexpected payout identifier.')
  }

  return { batchId, withdrawals: result }
}

export async function verifyNowPaymentsPayout(
  config: NowPaymentsPayoutConfig,
  batchId: string,
  verificationCode: string,
) {
  const response = await fetch(`${API_URL}/payout/${encodeURIComponent(batchId)}/verify`, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ verification_code: verificationCode }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new NowPaymentsApiError(
      providerMessage(body) ?? 'NOWPayments could not verify the payout.',
      response.status,
    )
  }
}

export async function getNowPaymentsPayoutStatus(apiKey: string, withdrawalId: string) {
  const response = await fetch(`${API_URL}/payout/${encodeURIComponent(withdrawalId)}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new NowPaymentsApiError(
      providerMessage(body) ?? 'Unable to load payout status from NOWPayments.',
      response.status,
    )
  }

  const entries = Array.isArray(body) ? body : [body]
  const status = entries.find(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      'id' in entry &&
      String(entry.id) === withdrawalId,
  )
  if (!status || typeof status.status !== 'string') {
    throw new NowPaymentsApiError('NOWPayments returned no status for the requested withdrawal.', 502)
  }

  return {
    withdrawalId,
    status: status.status.toUpperCase(),
    hash: typeof status.hash === 'string' ? status.hash : null,
    error: typeof status.error === 'string' ? status.error : null,
  } satisfies NowPaymentsPayoutStatus
}
