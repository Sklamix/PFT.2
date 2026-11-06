export const RISK_EQUITY_MODEL_VERSION = 'risk-equity-shadow-v1'
export const RISK_EQUITY_PHASE = 'phase-1-shadow-only'
export const RISK_EQUITY_SOURCE = {
  PROVISIONING: 'PROVISIONING',
  ADMIN_GRANT: 'ADMIN_GRANT',
  RESET: 'RESET',
  FUNDING: 'FUNDING',
  PHASE_TRANSITION: 'PHASE_TRANSITION',
} as const

export type RiskEquityStateValue = 'UNCLASSIFIED' | 'EXCLUDED' | 'SHADOW' | 'ENFORCE'
