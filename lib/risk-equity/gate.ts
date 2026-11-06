import { RISK_EQUITY_PHASE } from './constants'

/**
 * Phase 1 safety gate.
 *
 * Risk Equity may calculate and record shadow evidence, but it may never
 * authorize enforcement in this phase. The gate is intentionally fail-closed:
 * unknown state, missing baseline, EXCLUDED, or an attempted ENFORCE request
 * all result in no enforcement and no account mutation.
 *
 * A future phase may change this function only with explicit owner approval.
 */
export type RiskEquityGateMode = 'SHADOW' | 'DISABLED'

export type RiskEquityGateInput = {
  accountState: string | null | undefined
  baselineValid: boolean
  requestedMode?: string | null
}

export type RiskEquityGateResult = {
  mode: RiskEquityGateMode
  canEvaluateShadow: boolean
  canEnforce: false
  accountState: string
  baselineValid: boolean
  requestedMode: 'shadow' | 'enforce'
  reason:
    | 'SHADOW_READY'
    | 'PHASE_1_SHADOW_ONLY'
    | 'ACCOUNT_UNCLASSIFIED'
    | 'ACCOUNT_EXCLUDED'
    | 'ACCOUNT_ENFORCE_NOT_ALLOWED'
    | 'BASELINE_MISSING_OR_INVALID'
}

export function resolveRiskEquityGate(input: RiskEquityGateInput): RiskEquityGateResult {
  const requestedMode = input.requestedMode?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow'
  const state = input.accountState?.trim().toUpperCase() || 'UNCLASSIFIED'

  if (state === 'EXCLUDED') {
    return {
      mode: 'DISABLED',
      canEvaluateShadow: false,
      canEnforce: false,
      accountState: state,
      baselineValid: input.baselineValid,
      requestedMode,
      reason: 'ACCOUNT_EXCLUDED',
    }
  }

  if (state === 'ENFORCE') {
    // ENFORCE is reserved and cannot be activated in Phase 1.
    return {
      mode: 'DISABLED',
      canEvaluateShadow: false,
      canEnforce: false,
      accountState: state,
      baselineValid: input.baselineValid,
      requestedMode,
      reason: 'ACCOUNT_ENFORCE_NOT_ALLOWED',
    }
  }

  if (state !== 'SHADOW') {
    return {
      mode: 'DISABLED',
      canEvaluateShadow: false,
      canEnforce: false,
      accountState: state,
      baselineValid: input.baselineValid,
      requestedMode,
      reason: 'ACCOUNT_UNCLASSIFIED',
    }
  }

  if (!input.baselineValid) {
    return {
      mode: 'DISABLED',
      canEvaluateShadow: false,
      canEnforce: false,
      accountState: state,
      baselineValid: false,
      requestedMode,
      reason: 'BASELINE_MISSING_OR_INVALID',
    }
  }

  return {
    mode: 'SHADOW',
    canEvaluateShadow: true,
    canEnforce: false,
    accountState: state,
    baselineValid: true,
    requestedMode,
    reason: requestedMode === 'enforce' ? 'PHASE_1_SHADOW_ONLY' : 'SHADOW_READY',
  }
}

export function riskEquityPhaseLabel(): string {
  return RISK_EQUITY_PHASE
}
