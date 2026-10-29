export const CERTIFICATE_TYPES = ['PHASE_1', 'PHASE_2', 'FUNDED', 'PAYOUT'] as const
export type CertificateType = (typeof CERTIFICATE_TYPES)[number]

export const THEMES = ['GOLD', 'SILVER', 'NEBULA'] as const
export type CertificateTheme = (typeof THEMES)[number]

export const NAME_MODES = ['PROFILE', 'KYC'] as const
export type NameMode = (typeof NAME_MODES)[number]

export const STATUSES = ['VERIFIED', 'REVOKED'] as const
export type CertificateStatus = (typeof STATUSES)[number]

/** Approved personal-symbol emoji list. Server validates against this only. */
export const APPROVED_SYMBOLS = ['🪐', '🌙', '⭐', '🚀', '🌌', '☄️', '🛰️', '✨', '🌍', '🔥', '💫'] as const
export type PersonalSymbol = (typeof APPROVED_SYMBOLS)[number]

export const TYPE_TITLES: Record<CertificateType, string> = {
  PHASE_1: 'PHASE 1 COMPLETED',
  PHASE_2: 'PHASE 2 COMPLETED',
  FUNDED: 'FUNDED TRADER',
  PAYOUT: 'PAYOUT RECEIVED',
}

export function isCertificateType(value: unknown): value is CertificateType {
  return typeof value === 'string' && (CERTIFICATE_TYPES as readonly string[]).includes(value)
}

export function isTheme(value: unknown): value is CertificateTheme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

export function isNameMode(value: unknown): value is NameMode {
  return typeof value === 'string' && (NAME_MODES as readonly string[]).includes(value)
}

export function isApprovedSymbol(value: unknown): value is PersonalSymbol | null {
  if (value === null || value === '') return true
  return typeof value === 'string' && (APPROVED_SYMBOLS as readonly string[]).includes(value)
}
