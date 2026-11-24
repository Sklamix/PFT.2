# Worker brief — Phase 0–1: a truthful first screen and a measurement baseline

**Repo:** `C:\Users\User\Documents\Типовий проєкт`
**Branch:** `staging/ai-support-reliability` — work in it, do not create branches.

This brief is written for someone seeing this repository for the first time. Read Part 0 before
touching anything; it will save you from breaking things that took weeks to get right.

---

# Part 0 — Context

## 0.1 What this product is

**PFT (Professional Funded Trader)** is a proprietary trading firm. The business works like this:

1. A trader buys an **evaluation** (also called a challenge) for a fee.
2. They trade a simulated account and must hit a profit target without breaching drawdown rules.
3. If they pass, they get a **funded account** — still simulated, but now their profit is real money
   to us: they keep **80%**, we pay out **weekly**.
4. If they breach a rule, the account is closed. The fee is **not** refunded.

Every account on the platform is **simulated**. No real capital is allocated, no real orders reach a
market, PFT is not a broker and holds no client funds. This is stated in `/legal/terms` and in the
risk disclosure, and it must stay true in every word we publish.

The product's entire market position is **being the cheapest challenge on the market**. That is why
price honesty is not marketing decoration here — it is the product. A visitor who catches us
inflating a number has no reason left to trust the payout promise.

## 0.2 How the money works, and why this phase exists

- Evaluation fees: **$9 to $129**, one-time, non-refundable (`lib/challenges.ts` → `ACCOUNT_TIERS`).
- Paid add-ons: account resets, static drawdown (+15%), backup accounts.
- Payouts are a cost that only appears after a trader passes.

The homepage headline said **$200,000**, but the $50K, $100K and $200K tiers carry
`isAvailable: false`. The codebase already admits this in `lib/challenges.ts`:

```ts
export const UNAVAILABLE_TIER_MESSAGE =
  'Currently unavailable. Accounts above $25k are temporarily paused.'
```

and `components/challenge-calculator.tsx` renders a `Coming soon` badge on those tiers. The hero was
the last surface still claiming $200,000 as if it were purchasable. A visitor reads the claim and the
contradiction within one scroll. Fixing that is Phase 0.

## 0.3 Stack

| Layer | Technology |
|---|---|
| Framework | Next.js **16.4.5**, App Router, React **19** |
| Styling | TailwindCSS **4** (`@theme inline` tokens in `app/globals.css`) |
| Database | PostgreSQL (Neon) via Prisma **6.19** |
| Auth | NextAuth **5 beta** (email-code, no OAuth in production) |
| 3D hero | `three@0.186`, `@react-three/fiber@9`, `@react-three/drei@10` |
| Icons / state | `lucide-react`, `zustand` |
| Hosting | Vercel (`pft-app-prod`) |

**This Next.js version has breaking changes against your training data.** `AGENTS.md` says so, and it
is not a formality: before writing anything non-trivial in the App Router, check
`node_modules/next/dist/docs/`. For this brief you should not need to.

## 0.4 Repo map

```
app/                  routes
  page.tsx            homepage composition (Hero → PayoutProofs → Calculator → …)
  layout.tsx          root layout, metadata, <Analytics />
  legal/*             five draft legal documents (see 0.7)
  verify/[publicId]   public certificate verification
  dashboard/terminal  the trading terminal — authenticated, not a demo
  api/*               route handlers (checkout, trading, payouts, kyc, stats, …)
components/           marketing sections + design-system primitives in components/ui/
  hero.tsx            the homepage hero — the file this brief changes most
  home/               the hero planet: scene, hotspots, controller, cards, spot copy
  payout-proofs.tsx   payout feed + platform tiles, reads /api/stats
  challenge-calculator.tsx  pricing calculator, the only place a purchase starts
lib/                  domain logic — finance, risk-equity, trading, payments, payouts,
                      kyc, ai, security, stats, certificates, analytics (you will add this)
prisma/schema.prisma  single source of DB truth (~47 models)
scripts/              60+ node test scripts, run through npm run test:*
docs/                 rulebook v1, phase reports, and this brief in docs/marketing/
workers/              standalone candle / order workers
```

Useful commands: `npm run dev`, `npm run build`, `npm run lint`, `npm run test:unit`,
`npm run test:finance`, `npm run test:risk-equity`.

## 0.5 Do not touch the money code

`lib/finance/`, `lib/risk-equity/`, `lib/trading/`, `lib/payouts/`, `lib/payments/` hold the ledger
and the risk engine. Every amount there is `Prisma.Decimal`, never `float`, and several modules are
fail-closed by design. **Nothing in this brief requires opening them.** If you believe a change is
needed there, stop and report instead.

## 0.6 Current state of the hero

The hero was recently rebuilt into an interactive "Advantages Explorer", and it is fragile:

- the planet sits at the right centre and slowly auto-rotates;
- dragging it rotates with inertia (`components/home/planet-controller.ts` writes
  `style.transform` directly — deliberately **not** React state, to avoid 60 fps re-renders);
- five HTML `<button>` markers are projected from 3D each frame
  (`components/home/planet-hotspots.tsx`);
- clicking the planet body enters `focus` (centred, dimmed background); clicking a marker enters
  `detail` (planet right, card left);
- on phones the planet sits in a **measured slot** in the document flow, and the card opens as a
  bottom sheet.

Two commits produced this and both are under review. **Do not refactor it.** In this phase you
change exactly two strings in `hero.tsx`: the `h1` amount and one stat-card label.

## 0.7 Product facts you must not contradict

If your copy or code implies something different from this list, the site becomes inconsistent with
its own rulebook:

- profit split **80%**; payout cycle **weekly**; payout review **1–3 days**;
- **no time limit** on evaluation phases;
- 1-Step: target 10%, daily loss 4%, overall drawdown 6%, min 3 trading days;
- 2-Step: targets 8% then 5%, daily loss 5%, overall drawdown 10%, min 4 trading days per phase;
- static drawdown is a **paid add-on** (+15% on the fee), trailing is the default;
- the evaluation fee is **non-refundable**; resets are **paid**;
- maximum **3 active accounts** per trader;
- payouts are **crypto** (NOWPayments); KYC (Didit) is required before a funded status;
- trading happens on **our own web terminal** — there is no MT4/MT5;
- every account is **simulated**;
- the five documents under `/legal/*` are **drafts pending counsel review** and say so in a banner.

## 0.8 House rules

`CLAUDE.md` at the repo root governs all coding here. In practice, for this task:

- smallest possible diff; do not "improve" neighbouring code because you are already in the file;
- no new npm dependencies;
- do not weaken or delete tests to make a check pass;
- the working tree contains the owner's uncommitted work — never sweep it into your commit.

## 0.9 What this phase is **not**

Not a redesign. Not a new section. Not the competitor comparison. Not the public demo terminal (it
does not exist yet). Not legal copy. Not an SEO project. If you find yourself doing any of those,
you have left the brief.

---

# Part 1 — Decisions already taken by the owner

- **Headline drops to $25,000.** That is the largest tier actually on sale. Do **not** enable the
  higher tiers — that is a risk decision, not a marketing one.
- **No competitor names in any copy.** Comparison, when it comes, is self-description only.
- **The public demo terminal is deferred.**
- **Analytics are first-party**, written to our own database. No third-party event SDK.

---

# Part 2 — Phase 0: integrity

## 2.1 Lower the ceiling to what is on sale

Six surfaces claim $200,000. Change all six, or the fix is cosmetic.

**`components/hero.tsx`** — the `h1` (around line 243):

```tsx
Trade up to
<span className="mt-2 block text-primary">$200,000.</span>
```

→ `$25,000.` Leave `Trade up to` and `Keep 80% of the upside.` untouched. Do not change the clamp
values or the mobile layout.

**`components/hero.tsx`** — the stats array (around line 322):

```ts
['$200K', 'Max simulated capital'],
```

→ `['$25K', 'Max simulated capital'],`

**`components/payout-proofs.tsx`** — the tiles array (around line 99):

```ts
{ value: '$200K', label: 'Max simulated capital' },
```

→ `{ value: '$25K', label: 'Max simulated capital' },`

**`components/home/planet-spots.ts`** — the `challenges` spot:

- `heading`: `Two-step evaluation, up to $200,000` → `Two-step evaluation, up to $25,000`
- `body` → `Pass the evaluation, get the account. Up to $25,000 simulated capital and an 80% profit split on everything you earn.`

**`app/layout.tsx`** — metadata (lines 13–15):

- `title` → `Professional Funded Trader (PFT) — Trade up to $25K in Simulated Capital`
- `description` → `Get funded with Professional Funded Trader. 1-Step and 2-Step evaluations up to $25,000 per account, 80% profit split, no time limits, and weekly payouts on the PFT terminal.`

**`lib/ai/pft-knowledge.ts`** — line 75, currently:

> Maximum 3 active accounts per trader, with aggregate simulated allocation up to $200,000. A frozen backup counts only after activation.

→

> Maximum 3 active accounts per trader. The aggregate simulated allocation policy cap is $200,000, but the largest account size currently on sale is $25,000 — never tell a trader they can buy a larger account today. A frozen backup counts only after activation.

That line is what the AI support agent quotes back to traders. Left unchanged, support would promise a
product the checkout cannot sell.

**Done when** this returns nothing except the admin mock display ids:

```powershell
grep -rn "200,000\|200K" app components lib --include=*.tsx --include=*.ts
```

Expected remaining hits: `lib/admin/mock-store.ts` only (fake `PFT-200K-*` ids in admin demo data —
leave them).

## 2.2 Stop indexing the draft legal pages

All five documents under `app/legal/*` render a `Draft document — pending legal review` banner (see
`components/legal/legal-document.tsx`). None sets `robots`, so that banner is indexable.

Add to the exported `metadata` of each of these five files:

```ts
robots: { index: false, follow: true },
```

- `app/legal/terms/page.tsx`
- `app/legal/privacy/page.tsx`
- `app/legal/refund-policy/page.tsx`
- `app/legal/risk-disclosure/page.tsx`
- `app/legal/aml-kyc/page.tsx`

Do not touch the banner text, the copy, or `LegalDocument` itself. One field per file.

---

# Part 3 — Phase 1: first-party measurement

Page views keep working through the existing `<Analytics />` in `app/layout.tsx` — leave it alone.
Everything below is separate.

## 3.1 Event catalogue

Create `lib/analytics/events.ts` — **no `'use client'`**, imported by both the browser helper and the
API route so the allowlist cannot drift:

```ts
export const ANALYTICS_EVENTS = [
  'hero_cta_click',
  'hero_login_click',
  'planet_focus',
  'planet_marker_open',
  'advantage_card_cta',
  'calculator_checkout_open',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number]
```

## 3.2 Storage

Add to `prisma/schema.prisma`, next to the other telemetry models:

```prisma
model AnalyticsEvent {
  id        String   @id @default(cuid())
  name      String
  props     Json?
  path      String?
  sessionId String?
  createdAt DateTime @default(now())

  @@index([name, createdAt])
  @@index([createdAt])
}
```

No IP, no user agent, no user id, no email. `sessionId` is a random per-tab string, nothing else.

**This repo has no `prisma/migrations/` directory — it uses `prisma db push`.** Run
`npx prisma generate`, but **do not run `db push`**: it targets whatever `DATABASE_URL` is loaded and
production is not your call. State in the report that the owner must run `npx prisma db push`.

## 3.3 Ingest route

Create `app/api/events/route.ts`:

- `POST` only, `export const dynamic = 'force-dynamic'`.
- Body: `{ name: string, props?: Record<string, string | number | boolean>, path?: string, sessionId?: string }`.
- Validate by hand — **the repo has no `zod`, do not add it**:
  - `name` must be in `ANALYTICS_EVENTS`, else `400`;
  - `props` — at most 8 keys, values only string (≤ 64 chars) / finite number / boolean;
  - `path` ≤ 200 chars, `sessionId` ≤ 40 chars, both optional.
- Rate limit with the existing `lib/security/rate-limit-store.ts` (see
  `app/api/cron/trading/route.ts` for the import shape). Modest budget — a real visitor produces a
  handful of events per minute.
- Persist with `prisma.analyticsEvent.create`.
- **Analytics must never break the site**: wrap the write in `try/catch`; on storage failure still
  return `204` after a `console.error` that contains no payload contents and no IP.
- Return `204` on success; never return the stored row.

Optional and cheap: extend the existing prune in `app/api/cron/trading/route.ts` to delete
`AnalyticsEvent` rows older than 90 days, the way it already prunes rate-limit buckets and access
events. Skip it if that route looks risky — say so in the report.

## 3.4 Browser helper

Create `lib/analytics/track.ts`:

- `'use client'`.
- `trackEvent(name: AnalyticsEventName, props?: Record<string, string | number | boolean>)`.
- Gets or creates `sessionId` in `sessionStorage` via `crypto.randomUUID()`. No cookies, no
  `localStorage`, no PII.
- Sends with `navigator.sendBeacon('/api/events', new Blob([json], { type: 'application/json' }))`,
  falling back to `fetch(..., { keepalive: true })` when `sendBeacon` is missing or returns false.
- Wrapped in `try/catch`, returns `void`, never throws, no-ops when `typeof window === 'undefined'`.
- One comment explaining why the helper exists: the transport can change without touching call sites.

## 3.5 Extract the stats hook

`components/payout-proofs.tsx` contains a local `usePublicStats` hook that fetches `/api/stats` and
polls every 60 s. Move it verbatim into `lib/stats/use-public-stats.ts` (`'use client'`), export it,
and import it back.

Pure refactor: same fetch, same interval, same visibility listener, same fallback to
`FALLBACK_PUBLIC_STATS`. Phase 2 needs the same data in the hero and must not create a second poller.

## 3.6 Instrument the funnel

Each call goes in an event handler — **never in a render body, never in an effect that can re-run**.

| Event | Call site | Props |
|---|---|---|
| `hero_cta_click` | `components/hero.tsx`, the `Get Funded` anchor `onClick` | — |
| `hero_login_click` | both `Log in` anchors in `hero.tsx` (desktop + mobile) | — |
| `planet_focus` | `hero.tsx`, `onPlanetClick` | — |
| `planet_marker_open` | `hero.tsx`, `openSpot` | `{ spot }` |
| `advantage_card_cta` | `hero.tsx`, `navigateToSection` | `{ spot: href.slice(1) }` |
| `calculator_checkout_open` | `components/challenge-calculator.tsx`, where checkout state opens | `{ tier, type, fee }` |

`calculator_checkout_open` is the only event outside the hero. Touch nothing else in that file.

**Done when:** each action emits exactly one event, a re-render emits none, and `trackEvent` is never
called during render.

---

# Part 4 — Hard constraints

- Do **not** touch `components/site-header.tsx` or `components/site-footer.tsx`.
- Do **not** touch `components/home/hero-space-scene.tsx`, `planet-hotspots.tsx`,
  `planet-controller.ts`, `planet-advantage-card.tsx`, `planet-advantage-sheet.tsx`.
- Do **not** restructure the mobile hero. The only changes there are the `h1` string and one label.
- Do **not** add npm dependencies.
- Do **not** touch the owner's uncommitted work: `.vercelignore`, `app/staff/page.tsx`,
  `next-env.d.ts`, `package-lock.json`, `scripts/bootstrap-production.cjs`, `app/staff/AgentPanel.tsx`,
  `prisma/sql/push-subscriptions.sql`, `support-app/`, `*.apk`, `deploy.log`, `live1.txt`, `logs.txt`,
  `pull18.log`, `backup-before-db-push-*.json`, `.impeccable/`.
- Stage files by explicit path. **Never** `git add -A` or `git add .`.
- Do **not** push. Do **not** open a PR. Do **not** run `prisma db push`.
- No secrets, keys, `DATABASE_URL` or tokens in code, comments, logs or the commit message.

---

# Part 5 — Verification

```powershell
npx tsc --noEmit
npx eslint components/hero.tsx components/payout-proofs.tsx components/challenge-calculator.tsx lib/analytics/events.ts lib/analytics/track.ts lib/stats/use-public-stats.ts app/api/events/route.ts app/legal/terms/page.tsx app/legal/privacy/page.tsx app/legal/refund-policy/page.tsx app/legal/risk-disclosure/page.tsx app/legal/aml-kyc/page.tsx
npm run build
```

**Report honestly.** If `next build` fails because the sandbox blocks cleaning `.next`
(`SAFE_DELETE_BULK_CONFIRM_REQUIRED`), write `build: not verified — sandbox blocked .next cleanup`
with the exact error. Do not describe a check you did not see pass. A previous worker wrote
"Verified: build exit 0" for a build that had never run, and it cost more trust than the bug would
have.

Also confirm at 390 px that the hero still fits: the shorter `$25,000.` must not leave an awkward
gap, and the planet slot must stay above the fold.

---

# Part 6 — Commit

One commit, thematic, repo style:

```
fix(hero): sell $25,000, not $200,000

The homepage advertised $200,000 while the $50K, $100K and $200K tiers are
flagged isAvailable: false and the calculator labels them Coming soon. The
ceiling drops to the largest tier that can actually be bought, on every
surface that claimed it: hero, stats, payout tiles, planet card, metadata
and the AI support knowledge base.

Adds a first-party analytics sink (/api/events) and instruments the hero
CTA, login, planet focus, marker opens, card CTAs and calculator checkout,
so the next marketing change has a baseline in our own database.

Draft legal pages are noindexed until counsel review — their banner should
not sit in search results.

Verified: tsc clean, eslint clean. (build: <actual result>)
```

# Part 7 — Report back

1. Files changed, one line each.
2. The event table as implemented, with the exact call site.
3. Exit codes for `tsc` / `eslint` / `build` — actual, or explicitly "not verified".
4. Commit hash and `git show --stat`.
5. Anything you had to decide that this brief did not cover.
