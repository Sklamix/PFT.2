/**
 * Rules versioning (rulebook v1.6). Commercial terms are fixed at purchase and
 * risk/security changes apply immediately with a notice. No gap in enforcement,
 * no precedent and no earlier version creates a right to exploit a rule.
 */

export const RULES_VERSION = '1.6'
export const RULES_EFFECTIVE_DATE = '2026-10-27'

export const NO_ACQUIRED_RIGHT =
  'Trading does not grant any acquired right to exploit a rule, a technical gap or a delayed enforcement. ' +
  'Every trade and payout is assessed against the current rules. Where a change is required for risk, security ' +
  'or regulatory reasons, it applies immediately and is announced in the terminal; commercial terms are fixed at purchase.'

export type RuleChangeKind = 'risk' | 'commercial'

export type RuleChange = {
  version: string
  date: string
  kind: RuleChangeKind
  summary: string
}

/** Newest first. Keep one entry per released rules version. */
export const RULES_CHANGELOG: RuleChange[] = [
  {
    version: '1.6',
    date: '2026-10-27',
    kind: 'risk',
    summary:
      'News-window exposure is a violation even though orders are technically accepted; the first violation annuls that trade only, the second closes that account.',
  },
  {
    version: '1.6',
    date: '2026-10-27',
    kind: 'risk',
    summary:
      'Deterministic breach matrix, reset rules, payout holds, frozen-backup lifecycle and user-level risk review are now enforced automatically.',
  },
  {
    version: '1.6',
    date: '2026-10-27',
    kind: 'commercial',
    summary: '80/20 profit split, weekly payouts and a non-refundable evaluation fee.',
  },
]

function versionRank(version: string) {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
    .reduce((rank, part) => rank * 1000 + part, 0)
}

export function isKnownRuleVersion(value: string | null | undefined) {
  if (!value) return false
  return RULES_CHANGELOG.some((change) => change.version === value) || value === RULES_VERSION
}

/** Changes a user has not seen yet, newest first. An unknown/null version returns the full log. */
export function ruleChangesSince(version: string | null | undefined): RuleChange[] {
  if (!version) return RULES_CHANGELOG
  const rank = versionRank(version)
  return RULES_CHANGELOG.filter((change) => versionRank(change.version) > rank)
}
