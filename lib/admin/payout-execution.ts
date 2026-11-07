import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { toDecimal } from '@/lib/finance/money'
import { countUnresolvedFxReconciliations } from '@/lib/finance/fx-gate'
import { recomputeMetrics } from '@/lib/admin/risk'
import { isNowPaymentsPayoutConfigured } from '@/lib/nowpayments/config'

/**
 * Durable payout provider-execution state machine (verify-only for legacy rows).
 *
 * Provider withdrawal CREATION is permanently disabled. The only allowed network action
 * is `verifyNowPaymentsPayout()` for an existing `EXECUTION_V1` batch already in
 * `SUBMITTED`. A short transaction claims that verify attempt under row locks and sets an
 * account-level `payoutExecutionAt` lock; the network call is never made inside a
 * PostgreSQL transaction.
 *
 * Execution ownership: each attempt receives a unique owner token and a short lease.
 * Only the owner may finalize/record failure. A second worker cannot resume a live lease.
 *
 * `MANUAL_V1` is owner-confirmed off-platform and never enters this machine. `NULL` and
 * `LEGACY_MANUAL_APPROVAL` fail closed. Historical `CLAIMED` rows are frozen (no create
 * retry) and require manual reconciliation.
 */

export const PAYOUT_EXECUTION_STATES = {
  CLAIMED: 'CLAIMED',
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  FAILED: 'FAILED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
} as const

export type PayoutExecutionState = (typeof PAYOUT_EXECUTION_STATES)[keyof typeof PAYOUT_EXECUTION_STATES]

/**
 * Explicit provenance/execution-policy marker stamped at payout creation.
 *
 * `MANUAL_V1` is written by the payout request transaction for every new payout.
 * The owner transfers funds off-platform and confirms the payment through the
 * owner-only manual flow; no provider transfer is allowed for these rows.
 *
 * `EXECUTION_V1` is the legacy provider workflow. Existing rows keep it so a payout
 * that was already claimed/submitted can finish; new rows are never created with it.
 * `LEGACY_MANUAL_APPROVAL` may only be applied to a pre-existing row through the
 * evidence-allowlisted cutover SQL in `prisma/sql/financial-core.sql`; it is never
 * inferred from `executionState = null`, a date or the absence of provider IDs.
 */
export const PAYOUT_EXECUTION_POLICIES = {
  EXECUTION_V1: 'EXECUTION_V1',
  LEGACY_MANUAL_APPROVAL: 'LEGACY_MANUAL_APPROVAL',
  MANUAL_V1: 'MANUAL_V1',
} as const

export type PayoutExecutionPolicy =
  (typeof PAYOUT_EXECUTION_POLICIES)[keyof typeof PAYOUT_EXECUTION_POLICIES]

/** States that keep the account's `payoutExecutionAt` lock held. */
export const ACTIVE_EXECUTION_STATES: readonly PayoutExecutionState[] = [
  PAYOUT_EXECUTION_STATES.CLAIMED,
  PAYOUT_EXECUTION_STATES.SUBMITTED,
  PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED,
]

export function isActiveExecutionState(state: string | null | undefined): boolean {
  return state != null && (ACTIVE_EXECUTION_STATES as readonly string[]).includes(state)
}

/**
 * Fail closed: only a fully verified `APPROVED` execution may be disbursed. A null
 * `executionState` is unknown provenance, not evidence of a legacy payout.
 */
export function payoutApprovalBlockedByExecution(state: string | null | undefined): boolean {
  return state !== PAYOUT_EXECUTION_STATES.APPROVED
}

type PayoutProvenance = {
  executionPolicy: string | null | undefined
  executionState?: string | null
  executionKey?: string | null
  executionClaimedAt?: Date | null
  executionClaimedBy?: string | null
  executionLeaseUntil?: Date | null
  executionSnapshotHash: string | null | undefined
  id: string
  accountId: string
  amount: Prisma.Decimal
  network: string
  walletAddress: string
  balanceReserved: boolean
  profitSplitPct: number
}

export type PayoutApprovalGate =
  | { action: 'execution_approved' }
  | {
      action: 'blocked'
      reason:
        | 'provenance_unknown'
        | 'policy_conflict'
        | 'execution_incomplete'
        | 'reconciliation_required'
        | 'execution_failed'
        | 'snapshot_missing'
        | 'snapshot_mismatch'
        | 'legacy_disabled'
        | 'manual_policy'
    }

/**
 * Deterministic execution fingerprint. It is written at claim time and re-checked at
 * persist/finalize/approve so amount, network, address or account cannot change after
 * the provider call has started without failing closed.
 */
export function payoutExecutionSnapshot(input: {
  id: string
  accountId: string
  amount: Prisma.Decimal
  network: string
  walletAddress: string
  balanceReserved: boolean
  profitSplitPct: number
}): string {
  const payload = [
    input.id,
    input.accountId,
    input.amount.toFixed(2),
    input.network,
    input.walletAddress,
    input.balanceReserved ? 'reserved' : 'unreserved',
    String(input.profitSplitPct),
  ].join('|')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function payoutExecutionSnapshotMatches(payout: {
  executionSnapshotHash: string | null | undefined
  id: string
  accountId: string
  amount: Prisma.Decimal
  network: string
  walletAddress: string
  balanceReserved: boolean
  profitSplitPct: number
}): boolean {
  return (
    payout.executionSnapshotHash != null &&
    payout.executionSnapshotHash === payoutExecutionSnapshot(payout)
  )
}

/**
 * Single approval/debursement gate. Legacy provider payouts (`EXECUTION_V1`) may only be
 * disbursed after the execution machine reached `APPROVED` with an intact snapshot.
 * `MANUAL_V1` is confirmed by the owner through the manual flow and can never reach the
 * provider `DISBURSED` path. An explicitly marked `LEGACY_MANUAL_APPROVAL` row is
 * disabled and everything else fails closed.
 */
export function resolvePayoutApprovalGate(payout: PayoutProvenance): PayoutApprovalGate {
  if (payout.executionPolicy === PAYOUT_EXECUTION_POLICIES.EXECUTION_V1) {
    if (payout.executionState == null) {
      return { action: 'blocked', reason: 'provenance_unknown' }
    }
    if (payout.executionState === PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED) {
      return { action: 'blocked', reason: 'reconciliation_required' }
    }
    if (payout.executionState === PAYOUT_EXECUTION_STATES.FAILED) {
      return { action: 'blocked', reason: 'execution_failed' }
    }
    if (payout.executionState !== PAYOUT_EXECUTION_STATES.APPROVED) {
      return { action: 'blocked', reason: 'execution_incomplete' }
    }
    if (payout.executionSnapshotHash == null) {
      return { action: 'blocked', reason: 'snapshot_missing' }
    }
    if (!payoutExecutionSnapshotMatches(payout)) {
      return { action: 'blocked', reason: 'snapshot_mismatch' }
    }
    return { action: 'execution_approved' }
  }

  if (payout.executionPolicy === PAYOUT_EXECUTION_POLICIES.MANUAL_V1) {
    // Manual payouts never take the provider DISBURSED path; they are confirmed by the
    // owner through `confirmManualPayment`, not `approvePayout`.
    return { action: 'blocked', reason: 'manual_policy' }
  }

  if (payout.executionPolicy === PAYOUT_EXECUTION_POLICIES.LEGACY_MANUAL_APPROVAL) {
    // Legacy approval is disabled. There is no trusted two-administrator identity source
    // in this architecture, so `executionPolicy` can never legitimately become
    // LEGACY_MANUAL_APPROVAL (it is immutable once written) and no evidence row can be
    // created through a verified workflow. Any row carrying this marker — however it got
    // there — must fail closed rather than take a manual disbursement path.
    return { action: 'blocked', reason: 'legacy_disabled' }
  }

  return { action: 'blocked', reason: 'provenance_unknown' }
}

/**
 * Pure validation of a loaded legacy cutover evidence row. Legacy approval is currently
 * disabled (see `resolvePayoutApprovalGate`), so this validator documents the contract a
 * future trusted two-administrator cutover workflow must satisfy, and is exercised only
 * by tests. It never authorizes a disbursement on its own.
 */
export type LegacyEvidenceShape = {
  payoutId: string
  evidenceReference: string
  evidenceHash: string
  requestedBy: string | null
  verifiedBy: string | null
  requestedAt: Date
  verifiedAt: Date
}

export type LegacyEvidenceValidation =
  | { ok: true }
  | { ok: false; message: string }

export function validateLegacyEvidence(
  evidence: LegacyEvidenceShape | null | undefined,
  payoutId: string,
): LegacyEvidenceValidation {
  if (!evidence) {
    return { ok: false, message: 'No verified legacy cutover evidence exists for this payout.' }
  }
  if (evidence.payoutId !== payoutId) {
    return { ok: false, message: 'Legacy cutover evidence does not belong to this payout.' }
  }
  if (!/^[a-f0-9]{64}$/i.test(evidence.evidenceHash)) {
    return { ok: false, message: 'Legacy cutover evidence hash is malformed.' }
  }
  if (evidence.evidenceReference.length < 8) {
    return { ok: false, message: 'Legacy cutover evidence reference is too short.' }
  }
  if (!evidence.requestedBy || !evidence.verifiedBy) {
    return { ok: false, message: 'Legacy cutover evidence must have a requester and a verifier.' }
  }
  if (evidence.requestedBy === evidence.verifiedBy) {
    return { ok: false, message: 'Legacy cutover evidence must be requested and verified by different administrators.' }
  }
  if (!evidence.requestedAt || !evidence.verifiedAt) {
    return { ok: false, message: 'Legacy cutover evidence is missing its timestamps.' }
  }
  return { ok: true }
}

/** Lease duration for one execution owner. Expiry never authorizes a create retry. */
export const EXECUTION_LEASE_MS = 2 * 60_000

export class PayoutExecutionConflictError extends Error {
  constructor(readonly reason: 'ownership_lost' | 'state_changed' | 'not_found') {
    super(`payout execution conflict: ${reason}`)
    this.name = 'PayoutExecutionConflictError'
  }
}

export type ClaimPayout = {
  id: string
  accountId: string
  amount: Prisma.Decimal
  walletAddress: string
  network: string
  balanceReserved: boolean
}

export type ProviderExecutionBlockReason =
  | 'not_found'
  | 'manual_policy'
  | 'provenance_unknown'
  | 'provider_create_disabled'
  | 'mixed_batch'
  | 'not_pending'
  | 'not_verifiable'
  | 'provider_not_configured'

export type ProviderExecutionPlan =
  | { allowed: true; action: 'verify'; batchId: string }
  | { allowed: false; reason: ProviderExecutionBlockReason }

type ProviderExecutionPayout = {
  executionPolicy: string | null | undefined
  executionState: string | null | undefined
  status: string
  providerBatchId: string | null | undefined
  providerPayoutId: string | null | undefined
  providerStatus: string | null | undefined
}

/**
 * Single source of truth for provider network actions.
 *
 * Creating a NEW provider withdrawal is permanently disabled for every policy:
 * `provider_create_disabled` is returned whenever a batch does not already exist.
 * The only allowed network action is verifying an existing batch
 * (`verifyNowPaymentsPayout`), and only for an `EXECUTION_V1` payout that already
 * carries a provider batch/withdrawal awaiting verification.
 *
 * `MANUAL_V1`, `NULL` and `LEGACY_MANUAL_APPROVAL` never reach this path.
 */
export function resolveProviderExecutionPlan(
  payouts: readonly ProviderExecutionPayout[],
  options: { providerConfigured?: boolean } = {},
): ProviderExecutionPlan {
  if (payouts.length === 0) return { allowed: false, reason: 'not_found' }

  if (payouts.some((payout) => payout.executionPolicy === PAYOUT_EXECUTION_POLICIES.MANUAL_V1)) {
    return { allowed: false, reason: 'manual_policy' }
  }
  if (
    payouts.some(
      (payout) => payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.EXECUTION_V1,
    )
  ) {
    return { allowed: false, reason: 'provenance_unknown' }
  }

  const batchIds = new Set(
    payouts
      .map((payout) => payout.providerBatchId)
      .filter((batchId): batchId is string => batchId != null),
  )
  if (batchIds.size === 0) {
    // `EXECUTION_V1 + PENDING + executionState = null` (and any other row without an
    // existing provider batch) must never create a new withdrawal.
    return { allowed: false, reason: 'provider_create_disabled' }
  }
  if (batchIds.size !== 1 || payouts.some((payout) => payout.providerBatchId == null)) {
    return { allowed: false, reason: 'mixed_batch' }
  }

  if (payouts.some((payout) => payout.status !== 'PENDING')) {
    return { allowed: false, reason: 'not_pending' }
  }
  if (
    payouts.some(
      (payout) =>
        payout.providerPayoutId == null ||
        payout.providerStatus !== 'WAITING_FOR_VERIFICATION',
    )
  ) {
    return { allowed: false, reason: 'not_verifiable' }
  }
  if (
    payouts.some(
      (payout) => payout.executionState !== PAYOUT_EXECUTION_STATES.SUBMITTED,
    )
  ) {
    return { allowed: false, reason: 'not_verifiable' }
  }

  if (options.providerConfigured === false) {
    return { allowed: false, reason: 'provider_not_configured' }
  }

  return { allowed: true, action: 'verify', batchId: [...batchIds][0] }
}

export type PayoutClaimFailure =
  | 'not_found'
  | 'not_pending'
  | 'already_claimed'
  | 'reconciliation_required'
  | 'mixed_batch'
  | 'account_archived'
  | 'unresolved_fx'
  | 'open_positions'
  | 'pending_orders'
  | 'insufficient_balance'
  | 'reservation_invalid'
  | 'provenance_unknown'
  | 'manual_policy'
  | 'provider_create_disabled'
  | 'provider_not_configured'
  | 'not_verifiable'
  | 'execution_snapshot_mismatch'

export type PayoutClaimResult =
  | {
      ok: true
      action: 'verify'
      ownerToken: string
      batchId: string
      accountIds: string[]
      payouts: ClaimPayout[]
    }
  | { ok: false; reason: PayoutClaimFailure; detail?: string }

/**
 * Pure balance/eligibility policy for a payout at execution time.
 *
 * - Non-reserved (legacy) payouts debit the balance only at approval, so they must fit
 *   the current balance (`balance >= amount`).
 * - Reserved payouts already debited the balance at request time and segregated the
 *   amount into `reservedPayoutAmount`. The correct re-check is that the reservation is
 *   still intact (`reservedPayoutAmount >= amount`) and the account is not insolvent
 *   (`balance >= 0`).
 */
export function payoutExecutionBalanceBlocked(input: {
  balance: Prisma.Decimal | number | string
  amount: Prisma.Decimal | number | string
  balanceReserved: boolean
  reservedPayoutAmount: Prisma.Decimal | number | string
}): 'ok' | 'insufficient_balance' | 'reservation_invalid' {
  const balance = toDecimal(input.balance)
  const amount = toDecimal(input.amount)
  if (input.balanceReserved) {
    if (toDecimal(input.reservedPayoutAmount).lessThan(amount)) return 'reservation_invalid'
    if (balance.lessThan(0)) return 'insufficient_balance'
    return 'ok'
  }
  if (balance.lessThan(amount)) return 'insufficient_balance'
  return 'ok'
}

/**
 * Pure provider-error classification. Create and verify must never share the same
 * failure policy.
 */
export type ProviderFailureClass =
  | { action: 'create_definitive' }
  | { action: 'create_ambiguous' }
  | { action: 'verify_failure'; ambiguous: boolean }

/** Create-phase statuses that prove no withdrawal was created. Everything else is ambiguous. */
const DEFINITIVE_CREATE_STATUSES = new Set([400, 401, 403, 422])

export function classifyProviderFailure(
  phase: 'create' | 'verify',
  input: { isProviderError: boolean; status: number | null },
): ProviderFailureClass {
  if (phase === 'create') {
    return input.isProviderError && input.status != null && DEFINITIVE_CREATE_STATUSES.has(input.status)
      ? { action: 'create_definitive' }
      : { action: 'create_ambiguous' }
  }
  return {
    action: 'verify_failure',
    ambiguous: !input.isProviderError || input.status == null || input.status >= 500,
  }
}

export type ManualSubmissionInput = {
  providerBatchId?: unknown
  providerPayoutId?: unknown
  evidenceReference: unknown
  evidenceHash: unknown
  observedExternalId: unknown
  observedAmount: unknown
  observedCurrency: unknown
  observedAddress: unknown
  note?: unknown
}

export type ManualSubmissionData = {
  providerBatchId: string
  providerPayoutId: string
  evidenceReference: string
  evidenceHash: string
  observedExternalId: string
  observedAmount: Prisma.Decimal
  observedCurrency: string
  observedAddress: string
  note: string | null
}

export type ManualSubmissionValidation =
  | { ok: true; data: ManualSubmissionData }
  | { ok: false; message: string }

export const PROVIDER_CURRENCY_BY_NETWORK: Record<string, string> = {
  USDT_TRC20: 'usdttrc20',
  USDT_ERC20: 'usdterc20',
}

/**
 * Structural validation for the two-person manual submission reconciliation.
 * NOT_SUBMITTED is intentionally not supported: without a provider lookup by external
 * ID, absence of the operation cannot be proven, so the account must stay locked.
 */
export function validateManualSubmissionInput(input: ManualSubmissionInput): ManualSubmissionValidation {
  const providerBatchId = typeof input.providerBatchId === 'string' ? input.providerBatchId.trim() : ''
  const providerPayoutId = typeof input.providerPayoutId === 'string' ? input.providerPayoutId.trim() : ''
  if (!providerBatchId || !providerPayoutId) {
    return { ok: false, message: 'providerBatchId and providerPayoutId are required.' }
  }
  const evidenceReference =
    typeof input.evidenceReference === 'string' ? input.evidenceReference.trim() : ''
  if (evidenceReference.length < 8) {
    return { ok: false, message: 'A provider evidence reference of at least 8 characters is required.' }
  }
  const evidenceHash = typeof input.evidenceHash === 'string' ? input.evidenceHash.trim() : ''
  if (!/^[a-f0-9]{64}$/i.test(evidenceHash)) {
    return { ok: false, message: 'evidenceHash must be a SHA-256 hex digest (64 hex characters).' }
  }
  const observedExternalId =
    typeof input.observedExternalId === 'string' ? input.observedExternalId.trim() : ''
  const observedCurrency =
    typeof input.observedCurrency === 'string' ? input.observedCurrency.trim() : ''
  const observedAddress =
    typeof input.observedAddress === 'string' ? input.observedAddress.trim() : ''
  const rawAmount = typeof input.observedAmount === 'string' ? input.observedAmount.trim() : ''
  if (!observedExternalId || !observedCurrency || !observedAddress || !rawAmount) {
    return {
      ok: false,
      message: 'observedExternalId, observedAmount, observedCurrency and observedAddress are required.',
    }
  }
  let observedAmount: Prisma.Decimal
  try {
    observedAmount = new Prisma.Decimal(rawAmount)
  } catch {
    return { ok: false, message: 'observedAmount must be an exact decimal string.' }
  }
  if (!observedAmount.greaterThan(0)) return { ok: false, message: 'observedAmount must be positive.' }
  const note = typeof input.note === 'string' ? input.note.trim() : null
  if (note != null && note.length > 1000) return { ok: false, message: 'Note is too long (max 1000 characters).' }
  return {
    ok: true,
    data: {
      providerBatchId,
      providerPayoutId,
      evidenceReference,
      evidenceHash: evidenceHash.toLowerCase(),
      observedExternalId,
      observedAmount,
      observedCurrency,
      observedAddress,
      note,
    },
  }
}

/** Exact comparison of the attested provider operation against the local payout. */
export function validateSubmissionAgainstPayout(
  data: ManualSubmissionData,
  payout: { id: string; amount: Prisma.Decimal; network: string; walletAddress: string },
): { ok: true } | { ok: false; message: string } {
  if (data.observedExternalId !== payout.id) {
    return { ok: false, message: 'observedExternalId must equal the local payout id.' }
  }
  if (!data.observedAmount.equals(payout.amount)) {
    return { ok: false, message: 'observedAmount does not match the payout amount.' }
  }
  const expectedCurrency = PROVIDER_CURRENCY_BY_NETWORK[payout.network]
  if (!expectedCurrency || data.observedCurrency.toLowerCase() !== expectedCurrency) {
    return { ok: false, message: 'observedCurrency does not match the payout network.' }
  }
  if (data.observedAddress !== payout.walletAddress) {
    return { ok: false, message: 'observedAddress does not match the payout wallet address.' }
  }
  return { ok: true }
}

const PAYOUT_SELECT = {
  id: true,
  accountId: true,
  amount: true,
  walletAddress: true,
  network: true,
  status: true,
  balanceReserved: true,
  profitSplitPct: true,
  providerBatchId: true,
  providerPayoutId: true,
  providerStatus: true,
  executionPolicy: true,
  executionState: true,
  executionKey: true,
  executionClaimedAt: true,
  executionClaimedBy: true,
  executionLeaseUntil: true,
  executionSnapshotHash: true,
  transactionRef: true,
  paidAmount: true,
  paidCurrency: true,
} as const

type PayoutRow = Prisma.PayoutGetPayload<{ select: typeof PAYOUT_SELECT }>

const ACCOUNT_SELECT = {
  id: true,
  status: true,
  archivedAt: true,
  currentBalance: true,
  reservedPayoutAmount: true,
  currentEquity: true,
  balance: true,
  equity: true,
  dailyStartingBalance: true,
  dailyStartingEquity: true,
  initialBalance: true,
  peakEquity: true,
  peakEquityDecimal: true,
} as const

type AccountRow = Prisma.TradingAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>

function leaseIsValid(payout: PayoutRow, now: Date): boolean {
  return (
    payout.executionClaimedBy != null &&
    payout.executionLeaseUntil != null &&
    payout.executionLeaseUntil.getTime() > now.getTime()
  )
}

async function lockPayout(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Payout" WHERE "id" = ${id} FOR UPDATE
  `
  return rows.length > 0
}

async function lockAccount(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TradingAccount" WHERE "id" = ${id} FOR UPDATE
  `
  return rows.length > 0
}

async function loadPayouts(tx: Prisma.TransactionClient, ids: string[]): Promise<PayoutRow[]> {
  const rows = await tx.payout.findMany({ where: { id: { in: ids } }, select: PAYOUT_SELECT })
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

async function loadAccounts(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, AccountRow>> {
  const rows = await tx.tradingAccount.findMany({ where: { id: { in: ids } }, select: ACCOUNT_SELECT })
  return new Map(rows.map((row) => [row.id, row]))
}

type EligibilityFailure = { reason: PayoutClaimFailure; detail?: string } | null

async function checkEligibility(
  tx: Prisma.TransactionClient,
  payout: PayoutRow,
  account: AccountRow,
): Promise<EligibilityFailure> {
  if (account.archivedAt != null || account.status === 'ARCHIVED') {
    return { reason: 'account_archived' }
  }
  const unresolved = await countUnresolvedFxReconciliations(tx, payout.accountId)
  if (unresolved > 0) return { reason: 'unresolved_fx', detail: String(unresolved) }
  const [openPositions, pendingOrders] = await Promise.all([
    tx.position.count({ where: { tradingAccountId: payout.accountId, status: 'OPEN' } }),
    tx.pendingTradeOrder.count({ where: { tradingAccountId: payout.accountId, status: 'PENDING' } }),
  ])
  if (openPositions > 0) return { reason: 'open_positions', detail: String(openPositions) }
  if (pendingOrders > 0) return { reason: 'pending_orders', detail: String(pendingOrders) }
  const balance = payoutExecutionBalanceBlocked({
    balance: account.currentBalance,
    amount: payout.amount,
    balanceReserved: payout.balanceReserved,
    reservedPayoutAmount: account.reservedPayoutAmount,
  })
  if (balance === 'insufficient_balance') return { reason: 'insufficient_balance' }
  if (balance === 'reservation_invalid') return { reason: 'reservation_invalid' }
  return null
}

function toClaimPayouts(payouts: PayoutRow[]): ClaimPayout[] {
  return payouts.map((payout) => ({
    id: payout.id,
    accountId: payout.accountId,
    amount: payout.amount,
    walletAddress: payout.walletAddress,
    network: payout.network,
    balanceReserved: payout.balanceReserved,
  }))
}

/**
 * Commits the verify claim under locks. Throws on a failed CAS (caller rolls back).
 *
 * Provider CREATE is permanently disabled: the plan only allows `verify` for an
 * existing batch. A missing/invalid provider configuration blocks before any claim
 * field or account lock is written.
 */
export async function claimPayoutExecutionsInTx(
  tx: Prisma.TransactionClient,
  input: {
    ids: string[]
    actorId: string
    ownerToken: string
    now?: Date
    /** Injected by tests; production reads the live environment. */
    providerConfigured?: boolean
  },
): Promise<PayoutClaimResult> {
  const ids = [...new Set(input.ids)].sort()
  const ownerToken = input.ownerToken.trim()
  if (!ownerToken) throw new Error('ownerToken is required')
  const now = input.now ?? new Date()
  const leaseUntil = new Date(now.getTime() + EXECUTION_LEASE_MS)

  for (const id of ids) {
    if (!(await lockPayout(tx, id))) return { ok: false, reason: 'not_found', detail: id }
  }
  const payouts = await loadPayouts(tx, ids)
  if (payouts.length !== ids.length) return { ok: false, reason: 'not_found' }

  const plan = resolveProviderExecutionPlan(payouts, {
    providerConfigured:
      input.providerConfigured ?? isNowPaymentsPayoutConfigured(),
  })
  if (!plan.allowed) return { ok: false, reason: plan.reason }

  const accountIds = [...new Set(payouts.map((payout) => payout.accountId))].sort()
  for (const accountId of accountIds) {
    if (!(await lockAccount(tx, accountId))) {
      return { ok: false, reason: 'account_archived', detail: accountId }
    }
  }
  const accounts = await loadAccounts(tx, accountIds)

  for (const payout of payouts) {
    if (leaseIsValid(payout, now) && payout.executionClaimedBy !== ownerToken) {
      return { ok: false, reason: 'already_claimed', detail: payout.id }
    }
    if (!payoutExecutionSnapshotMatches(payout)) {
      return { ok: false, reason: 'execution_snapshot_mismatch', detail: payout.id }
    }
    const account = accounts.get(payout.accountId)
    if (!account) return { ok: false, reason: 'account_archived', detail: payout.accountId }
    const eligibility = await checkEligibility(tx, payout, account)
    if (eligibility) return { ok: false, reason: eligibility.reason, detail: eligibility.detail }
  }

  for (const payout of payouts) {
    const claimed = await tx.payout.updateMany({
      where: {
        id: payout.id,
        status: 'PENDING',
        executionPolicy: PAYOUT_EXECUTION_POLICIES.EXECUTION_V1,
        executionState: payout.executionState,
        executionClaimedBy: payout.executionClaimedBy,
        executionLeaseUntil: payout.executionLeaseUntil,
        providerBatchId: plan.batchId,
        providerPayoutId: payout.providerPayoutId,
        providerStatus: payout.providerStatus,
      },
      data: { executionClaimedBy: ownerToken, executionLeaseUntil: leaseUntil },
    })
    if (claimed.count !== 1) throw new PayoutExecutionConflictError('ownership_lost')
  }
  for (const accountId of accountIds) {
    await tx.tradingAccount.update({ where: { id: accountId }, data: { payoutExecutionAt: now } })
  }
  return {
    ok: true,
    action: 'verify',
    ownerToken,
    batchId: plan.batchId,
    accountIds,
    payouts: toClaimPayouts(payouts),
  }
}

/** Opens the transaction and runs the claim. Conflict errors are returned after rollback. */
export async function claimPayoutExecutions(
  prisma: PrismaClient,
  ids: string[],
  actorId: string,
  ownerToken: string,
): Promise<PayoutClaimResult> {
  try {
    return await prisma.$transaction((tx) => claimPayoutExecutionsInTx(tx, { ids, actorId, ownerToken }))
  } catch (error) {
    if (error instanceof PayoutExecutionConflictError) {
      return { ok: false, reason: 'already_claimed', detail: error.reason }
    }
    throw error
  }
}

/**
 * Best-effort ownership/lease check immediately before the external provider call.
 * This is a database read, NOT a fence: it cannot revoke an already-running or paused
 * HTTP request. Without a proven provider idempotency/fencing mechanism, a stale worker
 * that has passed this check can still submit after its lease expires.
 */
export async function assertPayoutExecutionLease(
  prisma: PrismaClient,
  ids: string[],
  ownerToken: string,
  action: 'create' | 'verify',
): Promise<boolean> {
  const payouts = await prisma.payout.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      executionState: true,
      executionClaimedBy: true,
      executionLeaseUntil: true,
    },
  })
  if (payouts.length !== new Set(ids).size) return false
  const now = new Date()
  return payouts.every((payout) => {
    if (payout.executionClaimedBy !== ownerToken) return false
    if (!payout.executionLeaseUntil || payout.executionLeaseUntil.getTime() <= now.getTime()) return false
    if (action === 'create') return payout.executionState === PAYOUT_EXECUTION_STATES.CLAIMED
    return (
      payout.executionState === PAYOUT_EXECUTION_STATES.SUBMITTED ||
      payout.executionState === PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED
    )
  })
}

/** Clears an account's execution lock when no active execution remains for it. */
async function releaseAccountIfIdle(tx: Prisma.TransactionClient, accountId: string) {
  const active = await tx.payout.count({
    where: { accountId, executionState: { in: [...ACTIVE_EXECUTION_STATES] } },
  })
  if (active === 0) {
    await tx.tradingAccount.update({ where: { id: accountId }, data: { payoutExecutionAt: null } })
  }
}

export type PersistCreatedResult =
  | { ok: true }
  | { ok: false; reason: 'state_changed'; detail?: string }

/** Persists a successful provider create, moving CLAIMED -> SUBMITTED. */
export async function persistCreatedPayoutExecution(
  prisma: PrismaClient,
  input: {
    ids: string[]
    batchId: string
    withdrawals: Array<{ payoutId: string; withdrawalId: string }>
    actorId: string
    ownerToken: string
  },
): Promise<PersistCreatedResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const payouts = await loadPayouts(tx, [...new Set(input.ids)].sort())
      const byPayout = new Map(input.withdrawals.map((withdrawal) => [withdrawal.payoutId, withdrawal]))
      if (payouts.length !== input.ids.length) throw new PayoutExecutionConflictError('not_found')
      for (const payout of payouts) {
        if (
          payout.executionState !== PAYOUT_EXECUTION_STATES.CLAIMED ||
          payout.executionClaimedBy !== input.ownerToken
        ) {
          throw new PayoutExecutionConflictError('ownership_lost')
        }
        if (!payoutExecutionSnapshotMatches(payout)) {
          throw new PayoutExecutionConflictError('state_changed')
        }
        if (!byPayout.has(payout.id)) throw new PayoutExecutionConflictError('state_changed')
      }
      for (const payout of payouts) {
        const withdrawal = byPayout.get(payout.id)!
        const changed = await tx.payout.updateMany({
          where: {
            id: payout.id,
            executionState: PAYOUT_EXECUTION_STATES.CLAIMED,
            executionClaimedBy: input.ownerToken,
          },
          data: {
            executionState: PAYOUT_EXECUTION_STATES.SUBMITTED,
            providerBatchId: input.batchId,
            providerPayoutId: withdrawal.withdrawalId,
            providerStatus: 'WAITING_FOR_VERIFICATION',
            executionLeaseUntil: new Date(Date.now() + EXECUTION_LEASE_MS),
          },
        })
        if (changed.count !== 1) throw new PayoutExecutionConflictError('ownership_lost')
      }
      await tx.auditLog.createMany({
        data: payouts.map((payout) => ({
          actorId: input.actorId,
          accountId: payout.accountId,
          action: 'PAYOUT_SUBMITTED_TO_NOWPAYMENTS',
          reason: 'Provider accepted the payout batch',
          metadata: { payoutId: payout.id, providerBatchId: input.batchId },
        })),
      })
      return { ok: true as const }
    })
  } catch (error) {
    if (error instanceof PayoutExecutionConflictError) {
      return { ok: false, reason: 'state_changed', detail: error.reason }
    }
    throw error
  }
}

export type FinalizeResult =
  | { ok: true; status: string }
  | { ok: false; reason: 'state_changed' | 'reconciliation_required'; detail?: string }

/** Moves SUBMITTED -> APPROVED after verification, and releases account locks. */
export async function finalizePayoutExecution(
  prisma: PrismaClient,
  input: { ids: string[]; actorId: string; ownerToken: string },
): Promise<FinalizeResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const ids = [...new Set(input.ids)].sort()
      for (const id of ids) {
        if (!(await lockPayout(tx, id))) throw new PayoutExecutionConflictError('not_found')
      }
      const payouts = await loadPayouts(tx, ids)
      if (payouts.length !== ids.length) throw new PayoutExecutionConflictError('not_found')
      const accountIds = [...new Set(payouts.map((payout) => payout.accountId))].sort()
      for (const accountId of accountIds) {
        if (!(await lockAccount(tx, accountId))) throw new PayoutExecutionConflictError('not_found')
      }
      const accounts = await loadAccounts(tx, accountIds)

      for (const payout of payouts) {
        if (
          payout.executionState !== PAYOUT_EXECUTION_STATES.SUBMITTED ||
          payout.executionClaimedBy !== input.ownerToken
        ) {
          throw new PayoutExecutionConflictError('ownership_lost')
        }
        if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.EXECUTION_V1) {
          throw new PayoutExecutionConflictError('state_changed')
        }
        if (!payoutExecutionSnapshotMatches(payout)) {
          throw new PayoutExecutionConflictError('state_changed')
        }
      }

      const ineligible: { payout: PayoutRow; reason: string }[] = []
      for (const payout of payouts) {
        const account = accounts.get(payout.accountId)
        if (!account) throw new PayoutExecutionConflictError('not_found')
        const eligibility = await checkEligibility(tx, payout, account)
        if (eligibility) ineligible.push({ payout, reason: eligibility.reason })
      }
      if (ineligible.length > 0) {
        // Atomic batch transition; no partial APPROVED rows.
        for (const payout of payouts) {
          const changed = await tx.payout.updateMany({
            where: {
              id: payout.id,
              executionState: PAYOUT_EXECUTION_STATES.SUBMITTED,
              executionClaimedBy: input.ownerToken,
            },
            data: {
              executionState: PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED,
              executionClaimedBy: null,
              executionLeaseUntil: null,
            },
          })
          if (changed.count !== 1) throw new PayoutExecutionConflictError('ownership_lost')
        }
        await tx.auditLog.createMany({
          data: payouts.map((payout) => ({
            actorId: input.actorId,
            accountId: payout.accountId,
            action: 'PAYOUT_FINALIZE_RECONCILIATION_REQUIRED',
            reason: 'Account changed after execution claim; payout requires reconciliation',
            metadata: { payoutId: payout.id, reasons: ineligible.map((item) => item.reason) },
          })),
        })
        return { ok: false as const, reason: 'reconciliation_required' as const }
      }

      for (const payout of payouts) {
        const changed = await tx.payout.updateMany({
          where: {
            id: payout.id,
            executionState: PAYOUT_EXECUTION_STATES.SUBMITTED,
            executionClaimedBy: input.ownerToken,
          },
          data: {
            status: 'APPROVED',
            executionState: PAYOUT_EXECUTION_STATES.APPROVED,
            providerStatus: 'WAITING',
            executionClaimedBy: null,
            executionLeaseUntil: null,
            reviewedAt: new Date(),
            reviewedById: input.actorId,
          },
        })
        if (changed.count !== 1) throw new PayoutExecutionConflictError('ownership_lost')
      }
      for (const accountId of accountIds) {
        await releaseAccountIfIdle(tx, accountId)
      }
      await tx.auditLog.createMany({
        data: payouts.map((payout) => ({
          actorId: input.actorId,
          accountId: payout.accountId,
          action: 'PAYOUT_APPROVED_FOR_DISBURSAL',
          reason: 'Provider payout verified and approved',
          metadata: { payoutId: payout.id },
        })),
      })
      return { ok: true as const, status: 'APPROVED' }
    })
  } catch (error) {
    if (error instanceof PayoutExecutionConflictError) {
      return { ok: false, reason: 'state_changed', detail: error.reason }
    }
    throw error
  }
}

/** Records a definitive create rejection (FAILED) or an ambiguous create (RECONCILIATION_REQUIRED). */
export async function failPayoutExecution(
  prisma: PrismaClient,
  input: {
    ids: string[]
    actorId: string
    ownerToken: string
    ambiguous: boolean
    providerStatus: string | null
    reason: string | null
  },
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const ids = [...new Set(input.ids)].sort()
      for (const id of ids) {
        if (!(await lockPayout(tx, id))) throw new PayoutExecutionConflictError('not_found')
      }
      const payouts = await loadPayouts(tx, ids)
      if (payouts.length !== ids.length) throw new PayoutExecutionConflictError('not_found')
      const accountIds = [...new Set(payouts.map((payout) => payout.accountId))].sort()
      for (const accountId of accountIds) {
        if (!(await lockAccount(tx, accountId))) throw new PayoutExecutionConflictError('not_found')
      }
      const targetState = input.ambiguous
        ? PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED
        : PAYOUT_EXECUTION_STATES.FAILED
      for (const payout of payouts) {
        const changed = await tx.payout.updateMany({
          where: {
            id: payout.id,
            executionState: { in: [PAYOUT_EXECUTION_STATES.CLAIMED, PAYOUT_EXECUTION_STATES.SUBMITTED] },
            executionClaimedBy: input.ownerToken,
          },
          data: {
            executionState: targetState,
            executionClaimedBy: null,
            executionLeaseUntil: null,
            ...(input.ambiguous ? { providerStatus: input.providerStatus } : {}),
          },
        })
        if (changed.count !== 1) throw new PayoutExecutionConflictError('ownership_lost')
      }
      for (const accountId of accountIds) {
        if (!input.ambiguous) await releaseAccountIfIdle(tx, accountId)
      }
      await tx.auditLog.createMany({
        data: payouts.map((payout) => ({
          actorId: input.actorId,
          accountId: payout.accountId,
          action: input.ambiguous ? 'PAYOUT_EXECUTION_RECONCILIATION_REQUIRED' : 'PAYOUT_EXECUTION_FAILED',
          reason: input.reason,
          metadata: { payoutId: payout.id, providerStatus: input.providerStatus },
        })),
      })
    })
  } catch (error) {
    if (error instanceof PayoutExecutionConflictError) return
    throw error
  }
}

/** Records a verification failure without changing SUBMITTED state or releasing the lock. */
export async function recordPayoutVerificationFailure(
  prisma: PrismaClient,
  input: { ids: string[]; actorId: string; ownerToken: string; ambiguous: boolean; reason: string | null },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payouts = await loadPayouts(tx, [...new Set(input.ids)])
    if (payouts.length !== new Set(input.ids).size) throw new PayoutExecutionConflictError('not_found')
    const allowedStates: string[] = input.ambiguous
      ? [PAYOUT_EXECUTION_STATES.SUBMITTED, PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED]
      : [PAYOUT_EXECUTION_STATES.SUBMITTED]
    for (const payout of payouts) {
      if (
        !allowedStates.includes(payout.executionState ?? '') ||
        payout.executionClaimedBy !== input.ownerToken
      ) {
        // Another worker/reconciliation owns the record; do not partially mutate it.
        return
      }
    }
    for (const payout of payouts) {
      const changed = await tx.payout.updateMany({
        where: {
          id: payout.id,
          executionState: { in: allowedStates },
          executionClaimedBy: input.ownerToken,
        },
        data: {
          executionClaimedBy: null,
          executionLeaseUntil: null,
          ...(input.ambiguous
            ? {
                executionState: PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED,
                providerStatus: 'VERIFICATION_UNKNOWN',
              }
            : {}),
        },
      })
      if (changed.count !== 1) throw new PayoutExecutionConflictError('ownership_lost')
    }
    await tx.auditLog.createMany({
      data: payouts.map((payout) => ({
        actorId: input.actorId,
        accountId: payout.accountId,
        action: 'PAYOUT_VERIFICATION_FAILED',
        reason: input.reason,
        metadata: { payoutId: payout.id, ambiguous: input.ambiguous },
      })),
    })
  })
}

export const SUBMISSION_RECONCILIATION_REQUEST_ACTION = 'PAYOUT_SUBMISSION_RECONCILIATION_REQUESTED'
export const SUBMISSION_RECONCILIATION_APPROVED_ACTION = 'PAYOUT_SUBMISSION_RECONCILED'

export type SubmissionReconciliationRequestResult =
  | { ok: true; requestId: string; payoutId: string }
  | {
      ok: false
      reason: 'not_found' | 'not_reconcilable' | 'request_pending' | 'validation'
      message?: string
    }

function metadataObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Step 1 of the two-person manual recovery for SUBMISSION_UNKNOWN.
 * Records the attested provider operation and evidence; it does not change payout state,
 * does not attach provider IDs and does not release the account lock.
 */
export async function requestPayoutSubmissionReconciliation(
  prisma: PrismaClient,
  payoutId: string,
  data: ManualSubmissionData,
  actorId: string,
): Promise<SubmissionReconciliationRequestResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payout" WHERE "id" = ${payoutId} FOR UPDATE
    `
    if (locked.length === 0) return { ok: false, reason: 'not_found' } as const
    const payout = await tx.payout.findUnique({ where: { id: payoutId } })
    if (!payout) return { ok: false, reason: 'not_found' } as const
    // Only the legacy provider workflow can be reconciled. A manual payout must never
    // acquire provider identifiers or a SUBMITTED state.
    if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.EXECUTION_V1) {
      return { ok: false, reason: 'not_reconcilable' } as const
    }
    if (
      payout.executionState !== PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED ||
      payout.status !== 'PENDING' ||
      payout.providerPayoutId != null
    ) {
      return { ok: false, reason: 'not_reconcilable' } as const
    }
    const match = validateSubmissionAgainstPayout(data, payout)
    if (!match.ok) return { ok: false, reason: 'validation', message: match.message } as const

    const existing = await tx.auditLog.findMany({
      where: { action: SUBMISSION_RECONCILIATION_REQUEST_ACTION },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, metadata: true, createdAt: true },
    })
    const pending = existing.some((row) => {
      const metadata = metadataObject(row.metadata)
      if (metadata?.payoutId !== payoutId) return false
      return Date.now() - row.createdAt.getTime() <= 24 * 60 * 60_000
    })
    if (pending) return { ok: false, reason: 'request_pending' } as const

    const request = await tx.auditLog.create({
      data: {
        actorId,
        accountId: payout.accountId,
        action: SUBMISSION_RECONCILIATION_REQUEST_ACTION,
        reason: data.note ?? null,
        metadata: {
          payoutId,
          providerBatchId: data.providerBatchId,
          providerPayoutId: data.providerPayoutId,
          evidenceReference: data.evidenceReference,
          evidenceHash: data.evidenceHash,
          observedExternalId: data.observedExternalId,
          observedAmount: data.observedAmount.toFixed(2),
          observedCurrency: data.observedCurrency,
          observedAddress: data.observedAddress,
          requestedBy: actorId,
          requestedAt: new Date().toISOString(),
        },
      },
      select: { id: true },
    })
    return { ok: true, requestId: request.id, payoutId } as const
  })
}

export type SubmissionReconciliationApproveResult =
  | { ok: true; payoutId: string; requestId: string }
  | {
      ok: false
      reason: 'not_found' | 'not_reconcilable' | 'already_resolved' | 'self_approval' | 'expired' | 'validation'
      message?: string
    }

/**
 * Step 2 of the two-person manual recovery. A different ADMIN approves the request.
 * It attaches provider IDs, moves RECONCILIATION_REQUIRED -> SUBMITTED and keeps the
 * account lock. It never marks the payout APPROVED/DISBURSED and never releases the
 * reservation.
 */
export async function approvePayoutSubmissionReconciliation(
  prisma: PrismaClient,
  payoutId: string,
  requestId: string,
  actorId: string,
): Promise<SubmissionReconciliationApproveResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Payout" WHERE "id" = ${payoutId} FOR UPDATE
    `
    if (locked.length === 0) return { ok: false, reason: 'not_found' } as const
    const payout = await tx.payout.findUnique({ where: { id: payoutId } })
    if (!payout) return { ok: false, reason: 'not_found' } as const
    // A manual payout can never become a provider payout through reconciliation.
    if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.EXECUTION_V1) {
      return { ok: false, reason: 'not_reconcilable' } as const
    }
    if (payout.executionState !== PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED) {
      return { ok: false, reason: 'already_resolved' } as const
    }
    if (payout.status !== 'PENDING' || payout.providerPayoutId != null) {
      return { ok: false, reason: 'not_reconcilable' } as const
    }

    const request = await tx.auditLog.findFirst({
      where: { id: requestId, action: SUBMISSION_RECONCILIATION_REQUEST_ACTION },
      select: { id: true, actorId: true, createdAt: true, metadata: true },
    })
    if (!request) return { ok: false, reason: 'not_found' } as const
    const metadata = metadataObject(request.metadata)
    if (!metadata || metadata.payoutId !== payoutId) return { ok: false, reason: 'not_found' } as const
    if (request.actorId === actorId) return { ok: false, reason: 'self_approval' } as const
    if (Date.now() - request.createdAt.getTime() > 24 * 60 * 60_000) {
      return { ok: false, reason: 'expired' } as const
    }
    const priorApproval = await tx.auditLog.findFirst({
      where: { action: SUBMISSION_RECONCILIATION_APPROVED_ACTION, reason: `request:${requestId}` },
      select: { id: true },
    })
    if (priorApproval) return { ok: false, reason: 'already_resolved' } as const

    let observedAmount: Prisma.Decimal
    try {
      observedAmount = new Prisma.Decimal(String(metadata.observedAmount ?? ''))
    } catch {
      return { ok: false, reason: 'validation', message: 'Stored observedAmount is invalid.' } as const
    }
    const data: ManualSubmissionData = {
      providerBatchId: String(metadata.providerBatchId ?? ''),
      providerPayoutId: String(metadata.providerPayoutId ?? ''),
      evidenceReference: String(metadata.evidenceReference ?? ''),
      evidenceHash: String(metadata.evidenceHash ?? ''),
      observedExternalId: String(metadata.observedExternalId ?? ''),
      observedAmount,
      observedCurrency: String(metadata.observedCurrency ?? ''),
      observedAddress: String(metadata.observedAddress ?? ''),
      note: null,
    }
    const match = validateSubmissionAgainstPayout(data, payout)
    if (!match.ok) return { ok: false, reason: 'validation', message: match.message } as const

    const changed = await tx.payout.updateMany({
      where: {
        id: payoutId,
        executionState: PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED,
        status: 'PENDING',
        providerPayoutId: null,
      },
      data: {
        executionState: PAYOUT_EXECUTION_STATES.SUBMITTED,
        providerBatchId: data.providerBatchId,
        providerPayoutId: data.providerPayoutId,
        providerStatus: 'WAITING_FOR_VERIFICATION',
        executionClaimedBy: null,
        executionLeaseUntil: null,
      },
    })
    if (changed.count !== 1) return { ok: false, reason: 'already_resolved' } as const

    await tx.auditLog.create({
      data: {
        actorId,
        accountId: payout.accountId,
        action: SUBMISSION_RECONCILIATION_APPROVED_ACTION,
        reason: `request:${requestId}`,
        metadata: {
          payoutId,
          requestId,
          requestedBy: request.actorId,
          approvedBy: actorId,
          approvedAt: new Date().toISOString(),
          providerBatchId: data.providerBatchId,
          providerPayoutId: data.providerPayoutId,
          evidenceReference: data.evidenceReference,
          evidenceHash: data.evidenceHash,
          observedExternalId: data.observedExternalId,
          observedAmount: data.observedAmount.toFixed(2),
          observedCurrency: data.observedCurrency,
          observedAddress: data.observedAddress,
        },
      },
    })
    return { ok: true, payoutId, requestId } as const
  })
}

export const MANUAL_PAYOUT_AUDIT_ACTIONS = {
  APPROVED_FOR_MANUAL_PAYMENT: 'PAYOUT_APPROVED_FOR_MANUAL_PAYMENT',
  MANUALLY_PAID: 'PAYOUT_MANUALLY_PAID',
  REJECTED: 'PAYOUT_REJECTED',
} as const

export type ManualPaymentInput = {
  paidAmount: Prisma.Decimal
  paidCurrency: string
  paidAt: Date
  paymentMethod: string
  transactionRef: string
}

export type ApproveManualPayoutResult =
  | { ok: true; payoutId: string; status: 'APPROVED' }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'wrong_policy'
        | 'not_pending'
        | 'state_changed'
        | PayoutClaimFailure
    }

export type ConfirmManualPaymentResult =
  | { ok: true; payoutId: string; status: 'MANUALLY_PAID'; alreadyCompleted: boolean }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'wrong_policy'
        | 'not_approved'
        | 'state_changed'
        | 'snapshot_mismatch'
        | 'amount_mismatch'
        | 'currency_mismatch'
        | 'missing_transaction_ref'
        | 'duplicate_transaction_ref'
        | 'already_paid_mismatch'
    }

/**
 * Manual approval (MANUAL_V1): PENDING -> APPROVED. Records the approver and freezes a
 * financial snapshot. No account debit and no reserve ledger entry are written here: the
 * amount was already debited and reserved at request time.
 */
export async function approveManualPayoutInTx(
  tx: Prisma.TransactionClient,
  input: { id: string; actorId: string; now?: Date },
): Promise<ApproveManualPayoutResult> {
  if (!(await lockPayout(tx, input.id))) return { ok: false, reason: 'not_found' }
  const [payout] = await loadPayouts(tx, [input.id])
  if (!payout) return { ok: false, reason: 'not_found' }
  if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.MANUAL_V1) {
    return { ok: false, reason: 'wrong_policy' }
  }
  if (payout.status !== 'PENDING') return { ok: false, reason: 'not_pending' }

  if (!(await lockAccount(tx, payout.accountId))) return { ok: false, reason: 'not_found' }
  const account = (await loadAccounts(tx, [payout.accountId])).get(payout.accountId)
  if (!account) return { ok: false, reason: 'not_found' }
  const eligibility = await checkEligibility(tx, payout, account)
  if (eligibility) return { ok: false, reason: eligibility.reason }

  const now = input.now ?? new Date()
  const snapshotHash = payoutExecutionSnapshot(payout)
  const changed = await tx.payout.updateMany({
    where: {
      id: payout.id,
      status: 'PENDING',
      executionPolicy: PAYOUT_EXECUTION_POLICIES.MANUAL_V1,
      executionSnapshotHash: payout.executionSnapshotHash,
    },
    data: {
      status: 'APPROVED',
      executionSnapshotHash: snapshotHash,
      approvedById: input.actorId,
      approvedAt: now,
      reviewedById: input.actorId,
      reviewedAt: now,
    },
  })
  if (changed.count !== 1) throw new PayoutExecutionConflictError('state_changed')

  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      accountId: payout.accountId,
      action: MANUAL_PAYOUT_AUDIT_ACTIONS.APPROVED_FOR_MANUAL_PAYMENT,
      metadata: { payoutId: payout.id },
    },
  })
  return { ok: true, payoutId: payout.id, status: 'APPROVED' }
}

/**
 * Manual confirmation (MANUAL_V1): APPROVED -> MANUALLY_PAID. Owner-supplied evidence is
 * exactly the unique transaction reference plus the exact paid amount/currency. No second
 * balance debit and no payout ledger entry are produced; only the reserved-amount
 * aggregate is recomputed from the remaining PENDING/APPROVED payouts.
 */
export async function confirmManualPaymentInTx(
  tx: Prisma.TransactionClient,
  input: { id: string; ownerId: string } & ManualPaymentInput,
): Promise<ConfirmManualPaymentResult> {
  if (!(await lockPayout(tx, input.id))) return { ok: false, reason: 'not_found' }
  const [payout] = await loadPayouts(tx, [input.id])
  if (!payout) return { ok: false, reason: 'not_found' }
  if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.MANUAL_V1) {
    return { ok: false, reason: 'wrong_policy' }
  }
  if (payout.status === 'MANUALLY_PAID') {
    // Deterministic already-completed result. A re-submission must match the stored
    // evidence; otherwise it is a conflict, not a silent success.
    const ref = input.transactionRef.trim()
    const sameRef = payout.transactionRef === ref
    const sameAmount = payout.paidAmount != null && payout.paidAmount.equals(input.paidAmount)
    const sameCurrency = payout.paidCurrency === input.paidCurrency
    if (!sameRef || !sameAmount || !sameCurrency) {
      return { ok: false, reason: 'already_paid_mismatch' }
    }
    return { ok: true, payoutId: payout.id, status: 'MANUALLY_PAID', alreadyCompleted: true }
  }
  if (payout.status !== 'APPROVED') return { ok: false, reason: 'not_approved' }

  if (!payoutExecutionSnapshotMatches(payout)) return { ok: false, reason: 'snapshot_mismatch' }
  if (!input.paidAmount.equals(payout.amount)) return { ok: false, reason: 'amount_mismatch' }
  if (input.paidCurrency !== payout.network) return { ok: false, reason: 'currency_mismatch' }
  const ref = input.transactionRef.trim()
  if (!ref) return { ok: false, reason: 'missing_transaction_ref' }

  const duplicates = await tx.payout.findMany({
    where: { transactionRef: ref },
    select: { id: true },
  })
  if (duplicates.some((row) => row.id !== payout.id)) {
    return { ok: false, reason: 'duplicate_transaction_ref' }
  }

  const changed = await tx.payout.updateMany({
    where: {
      id: payout.id,
      status: 'APPROVED',
      executionPolicy: PAYOUT_EXECUTION_POLICIES.MANUAL_V1,
      executionSnapshotHash: payout.executionSnapshotHash,
      amount: payout.amount,
      accountId: payout.accountId,
      network: payout.network,
      walletAddress: payout.walletAddress,
      balanceReserved: payout.balanceReserved,
      profitSplitPct: payout.profitSplitPct,
    },
    data: {
      status: 'MANUALLY_PAID',
      paidAmount: input.paidAmount,
      paidCurrency: input.paidCurrency,
      paidAt: input.paidAt,
      paymentMethod: input.paymentMethod,
      transactionRef: ref,
      paidById: input.ownerId,
      reviewedById: input.ownerId,
      reviewedAt: input.paidAt,
    },
  })
  if (changed.count !== 1) throw new PayoutExecutionConflictError('state_changed')

  // Recalculate the reserved amount from the remaining open payouts. This mirrors the
  // established DISBURSED reserved-path behaviour and never touches currentBalance.
  const reserved = await tx.payout.aggregate({
    where: { accountId: payout.accountId, status: { in: ['PENDING', 'APPROVED'] } },
    _sum: { amount: true },
  })
  await tx.tradingAccount.update({
    where: { id: payout.accountId },
    data: { reservedPayoutAmount: reserved._sum.amount ?? new Prisma.Decimal(0) },
  })

  await tx.auditLog.create({
    data: {
      actorId: input.ownerId,
      accountId: payout.accountId,
      action: MANUAL_PAYOUT_AUDIT_ACTIONS.MANUALLY_PAID,
      metadata: {
        payoutId: payout.id,
        transactionRef: ref,
        paidAmount: input.paidAmount.toFixed(2),
        paidCurrency: input.paidCurrency,
        paymentMethod: input.paymentMethod,
        paidById: input.ownerId,
        paidAt: input.paidAt.toISOString(),
      },
    },
  })
  return { ok: true, payoutId: payout.id, status: 'MANUALLY_PAID', alreadyCompleted: false }
}

export type RejectManualPayoutResult =
  | { ok: true; payoutId: string; status: 'REJECTED'; alreadyRejected: boolean }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'wrong_policy'
        | 'not_approved'
        | 'state_changed'
    }

/** Recomputes `reservedPayoutAmount` from the remaining open payouts; returns the total. */
async function recomputeReservedPayoutAmount(tx: Prisma.TransactionClient, accountId: string) {
  const reserved = await tx.payout.aggregate({
    where: { accountId, status: { in: ['PENDING', 'APPROVED'] } },
    _sum: { amount: true },
  })
  return reserved._sum.amount ?? new Prisma.Decimal(0)
}

/**
 * Manual rejection (MANUAL_V1): APPROVED -> REJECTED. Restores the original reserve
 * exactly once (credit balance + PAYOUT_RELEASE ledger entry) and recalculates
 * reservedPayoutAmount. It never debits and never touches provider execution.
 */
export async function rejectManualPayoutInTx(
  tx: Prisma.TransactionClient,
  input: { id: string; actorId: string; reason: string },
): Promise<RejectManualPayoutResult> {
  if (!(await lockPayout(tx, input.id))) return { ok: false, reason: 'not_found' }
  const [payout] = await loadPayouts(tx, [input.id])
  if (!payout) return { ok: false, reason: 'not_found' }
  if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.MANUAL_V1) {
    return { ok: false, reason: 'wrong_policy' }
  }
  if (payout.status === 'REJECTED') {
    return { ok: true, payoutId: payout.id, status: 'REJECTED', alreadyRejected: true }
  }
  if (payout.status !== 'APPROVED') return { ok: false, reason: 'not_approved' }

  if (!(await lockAccount(tx, payout.accountId))) return { ok: false, reason: 'not_found' }
  const before = (await loadAccounts(tx, [payout.accountId])).get(payout.accountId)
  if (!before) return { ok: false, reason: 'not_found' }

  // Approved policy: forfeiture applies only to terminal accounts. BREACHED* is NOT
  // terminal (an appeal can restore it), so it takes the release path below.
  const terminal =
    before.archivedAt != null ||
    (before.status as string) === 'ARCHIVED' ||
    (before.status as string) === 'EXPIRED'

  const now = new Date()
  const changed = await tx.payout.updateMany({
    where: {
      id: payout.id,
      status: 'APPROVED',
      executionPolicy: PAYOUT_EXECUTION_POLICIES.MANUAL_V1,
    },
    data: {
      status: 'REJECTED',
      rejectReason: input.reason,
      reviewedAt: now,
      reviewedById: input.actorId,
      executionSnapshotHash: null,
      ...(terminal
        ? { forfeitedAt: now, cancelSource: 'ACCOUNT_CLOSED_FORFEITURE' }
        : {}),
    },
  })
  if (changed.count !== 1) throw new PayoutExecutionConflictError('state_changed')

  if (terminal) {
    // Forfeiture: the reserve is not returned to the balance and no PAYOUT_RELEASE
    // (and no zero ledger entry) is created. Only the reserved-amount aggregate is
    // recomputed from the remaining open payouts.
    const reservedAfter = await recomputeReservedPayoutAmount(tx, payout.accountId)
    await tx.tradingAccount.update({
      where: { id: payout.accountId },
      data: { reservedPayoutAmount: reservedAfter },
    })
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        accountId: payout.accountId,
        action: MANUAL_PAYOUT_AUDIT_ACTIONS.REJECTED,
        reason: input.reason,
        metadata: {
          payoutId: payout.id,
          manual: true,
          cancelSource: 'ACCOUNT_CLOSED_FORFEITURE',
          forfeitedAt: now.toISOString(),
          forfeitedAmount: payout.amount.toFixed(2),
        },
      },
    })
    return { ok: true, payoutId: payout.id, status: 'REJECTED', alreadyRejected: false }
  }

  // Restore the reserve exactly once. The account row is locked, so read-modify-write
  // under the lock is atomic. balanceReserved is always true for MANUAL_V1 requests.
  const amount = payout.amount
  const currentEquity = before.currentEquity.plus(amount)
  const dailyStartingEquity = before.dailyStartingEquity.plus(amount)
  await tx.tradingAccount.update({
    where: { id: payout.accountId },
    data: {
      currentBalance: before.currentBalance.plus(amount),
      currentEquity,
      balance: before.balance + Number(amount),
      equity: before.equity + Number(amount),
      dailyStartingBalance: before.dailyStartingBalance.plus(amount),
      dailyStartingEquity,
    },
  })
  const metrics = recomputeMetrics({
    initialBalance: Number(before.initialBalance),
    dailyStartingEquity: Number(dailyStartingEquity),
    currentEquity: Number(currentEquity),
  })
  const reserved = await recomputeReservedPayoutAmount(tx, payout.accountId)
  await tx.tradingAccount.update({
    where: { id: payout.accountId },
    data: { ...metrics, reservedPayoutAmount: reserved },
  })

  await tx.accountLedgerEntry.create({
    data: {
      accountId: payout.accountId,
      type: 'PAYOUT_RELEASE',
      amount,
      currency: 'USD',
      balanceAfter: before.currentBalance.plus(amount),
      refType: 'PAYOUT',
      refId: payout.id,
      idempotencyKey: `payout-release:${payout.id}`,
      metadata: { reason: input.reason, manual: true },
    },
  })

  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      accountId: payout.accountId,
      action: MANUAL_PAYOUT_AUDIT_ACTIONS.REJECTED,
      reason: input.reason,
      metadata: { payoutId: payout.id, manual: true },
    },
  })
  return { ok: true, payoutId: payout.id, status: 'REJECTED', alreadyRejected: false }
}
