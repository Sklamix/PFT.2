/**
 * Presentation rules for public spread/commission values.
 *
 * The registry seed writes `avgSpread = 0` for instruments without samples.
 * Zero is not a spread: it must render as "no data", never as a zero-spread claim.
 */

export function hasVerifiedSpreadSample(avgSpread: number): boolean {
  return Number.isFinite(avgSpread) && avgSpread > 0
}

/**
 * Returns the rate only when the tariff is explicitly configured.
 * A stored 0 with `commissionConfigured = false` is an unset placeholder, not free trading.
 */
export function configuredCommissionRate(commissionConfigured: boolean, commissionPerLot: number): number | null {
  if (!commissionConfigured) return null
  return Number.isFinite(commissionPerLot) && commissionPerLot >= 0 ? commissionPerLot : null
}
