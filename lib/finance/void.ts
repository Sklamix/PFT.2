import { Prisma } from '@prisma/client'
import { roundMoney, toDecimal } from './money'

/**
 * Explicit void reversal components.
 *
 * Voiding a trade returns its full net result:
 * - price PnL reversal;
 * - entry commission refund;
 * - exit commission refund.
 *
 * For historical rows without gross/commission data we can only reverse the
 * stored net `pnl`; no values are invented.
 */
export type VoidComponent = 'TRADE_PNL' | 'ENTRY_COMMISSION' | 'EXIT_COMMISSION'

export type VoidLedgerPart = {
  component: VoidComponent
  amount: Prisma.Decimal
  originalAmount: Prisma.Decimal | null
  /** Set when the row's gross/commission fields disagree with its net pnl. */
  synthetic?: boolean
}

function balanced(parts: VoidLedgerPart[], pnl: number): VoidLedgerPart[] {
  const target = roundMoney(toDecimal(pnl).negated())
  const total = parts.reduce((sum, part) => sum.plus(part.amount), toDecimal(0))
  const difference = roundMoney(target.minus(total))
  if (!difference.isZero()) {
    parts.push({
      component: 'TRADE_PNL',
      amount: difference,
      originalAmount: null,
      synthetic: true,
    })
  }
  return parts
}

export function voidLedgerParts(trade: {
  pnl: number
  grossPnl: number | null
  entryCommission: Prisma.Decimal | null
  exitCommission: Prisma.Decimal | null
}): VoidLedgerPart[] {
  const entry = trade.entryCommission == null ? null : toDecimal(trade.entryCommission)
  const exit = trade.exitCommission == null ? null : toDecimal(trade.exitCommission)
  const gross = trade.grossPnl == null ? null : toDecimal(trade.grossPnl)

  if (gross != null) {
    const parts: VoidLedgerPart[] = []
    if (!gross.isZero()) {
      parts.push({ component: 'TRADE_PNL', amount: roundMoney(gross.negated()), originalAmount: gross })
    }
    if (entry != null && !entry.isZero()) {
      parts.push({ component: 'ENTRY_COMMISSION', amount: roundMoney(entry), originalAmount: entry })
    }
    if (exit != null && !exit.isZero()) {
      parts.push({ component: 'EXIT_COMMISSION', amount: roundMoney(exit), originalAmount: exit })
    }
    return balanced(parts, trade.pnl)
  }

  // Unresolved FX close: gross PnL is unknown, only the known commissions are
  // refunded. `pnl` was stored as negative commissions, so this reverses exactly.
  if (entry != null || exit != null) {
    const parts: VoidLedgerPart[] = []
    if (entry != null && !entry.isZero()) {
      parts.push({ component: 'ENTRY_COMMISSION', amount: roundMoney(entry), originalAmount: entry })
    }
    if (exit != null && !exit.isZero()) {
      parts.push({ component: 'EXIT_COMMISSION', amount: roundMoney(exit), originalAmount: exit })
    }
    return balanced(parts, trade.pnl)
  }

  // Legacy trade: only the stored net PnL is known.
  const pnl = toDecimal(trade.pnl)
  if (pnl.isZero()) return []
  return [{ component: 'TRADE_PNL', amount: roundMoney(pnl.negated()), originalAmount: pnl }]
}
