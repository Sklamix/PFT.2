export type NowPaymentsPayoutConfig = {
  apiKey: string
  email: string
  password: string
}

const REQUIRED_PAYOUT_ENV = {
  apiKey: 'NOWPAYMENTS_API_KEY',
  email: 'NOWPAYMENTS_PAYOUT_EMAIL',
  password: 'NOWPAYMENTS_PAYOUT_PASSWORD',
} as const

export function requireNowPaymentsPayoutConfig(
  env: NodeJS.ProcessEnv = process.env,
): NowPaymentsPayoutConfig {
  const apiKey = env[REQUIRED_PAYOUT_ENV.apiKey]?.trim()
  const email = env[REQUIRED_PAYOUT_ENV.email]?.trim()
  const password = env[REQUIRED_PAYOUT_ENV.password]
  const missing: string[] = []
  if (!apiKey) missing.push(REQUIRED_PAYOUT_ENV.apiKey)
  if (!email) missing.push(REQUIRED_PAYOUT_ENV.email)
  if (!password?.trim()) missing.push(REQUIRED_PAYOUT_ENV.password)

  if (missing.length > 0 || !apiKey || !email || !password?.trim()) {
    throw new Error(`NOWPayments Payout API is not configured. Missing: ${missing.join(', ')}`)
  }

  return { apiKey, email, password }
}

/**
 * Non-throwing membership check used by the payout policy before any claim is
 * committed. Manual payouts and disabled legacy create paths must not require
 * provider credentials at all.
 */
export function isNowPaymentsPayoutConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const apiKey = env[REQUIRED_PAYOUT_ENV.apiKey]?.trim()
  const email = env[REQUIRED_PAYOUT_ENV.email]?.trim()
  const password = env[REQUIRED_PAYOUT_ENV.password]
  return Boolean(apiKey && email && password?.trim())
}
