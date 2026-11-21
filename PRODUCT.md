# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: a retail trader going through a challenge to reach a funded trading account. Their job: buy a challenge, pass its targets without violating drawdown/news rules, then request payouts from the funded account. Secondary (confirmed by role separation in code): platform administrators who approve payouts, fundings, appeals, and manage risk flags.

## Product Purpose

PFT is a proprietary-trading-firm platform: it sells evaluation challenges and, for those who pass, gives access to funded simulated-capital accounts with real payout withdrawals. Success = a trader completes the challenge honestly (KYC-verified, single identity, rulebook-compliant) and repeatedly receives payouts, while the platform blocks and documents every path to rule evasion.

## Positioning

Lowest challenge purchase price on the market (owner-confirmed). Everything else — rule enforcement, payout discipline — is the trust contract that makes the cheap price safe to offer.

## Operating Context

- Rulebook `docs/PFT-rulebook-v1.md` (currently v1.6) is the binding source of product rules; public copy must match it (80% profit split, weekly payouts, no refund, news windows, 2-day reset, CE(S)T matches).
- KYC is mandatory before funded status (verified via Didit). Payouts go through NOWPayments; email through Resend.
- Compliance surfaces are product features, not afterthoughts: `/legal/*` pages (draft, pending counsel sign-off), risk disclosure, AML/KYC, refunds policy.
- Administrators must not be able to self-approve payouts/fundings (different-admin approval enforced in code).

## Capabilities and Constraints

- Challenge checkout with intent dedup, payment webhooks fail-closed, payment-recovery queue for stuck payments.
- Risk engine: fixed-dollar trailing drawdown, static floor, daily loss at 00:00 Europe/Berlin, news ±5 min windows, overnight/weekend close-only, inactivity closure (60/90 days).
- Archive semantics: accounts are soft-archived, hard-delete impossible by design (append-only ledger).
- No OAuth in production (email-code login only, single active session).
- Dark-only visual system (`color-scheme: dark`); no light theme planned.

## Brand Commitments

Owner-bound (this session): cosmic/modern dark style. The incumbent "cosmic terminal" world — deep-space dark palette, violet-blue accents, Geist type pair — stays. This is a commitment to the world, not to every current implementation detail.

## Evidence on Hand

- `docs/PFT-rulebook-v1.md` — full rule contract (binding).
- `docs/PFT-launch-qa.md`, `docs/PFT-production-rollout.md` — verified QA state, go/no-go checklists.
- Production deployment on Vercel (`pft-app-prod`), `/api/health` operational.
- No testimonials, marketing imagery, or case studies exist yet — future work must not fabricate them.

## Product Principles

1. The rulebook wins: any UI copy about money, timing, or limits traces to the rulebook version in force.
2. Fail closed: when a payment, KYC, or payout check is uncertain, the system blocks and explains rather than guesses.
3. Cheap to start, hard to cheat: pricing is the hook; enforcement is the product.
4. Compute, never claim: status, balances, and drawdown numbers come from the engine, never from static copy.
