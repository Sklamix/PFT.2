# Worker brief — Chart context menu and price alerts

**Repo:** `C:\Users\User\Documents\Типовий проєкт`
**Branch:** `staging/ai-support-reliability` — work in it, do not create branches.
**Scope owner decisions already made:** right-click on the chart only, desktop only, no order
placement from the menu, alerts delivered by email.

Read Part 0 before touching anything. It explains what you are working inside and which invariants
you must not break.

---

# Part 0 — Context

## 0.1 What this product is

**PFT (Professional Funded Trader)** is a proprietary trading firm. A trader buys an evaluation,
trades a **simulated** account, and must hit a profit target without breaching drawdown rules. Passing
gives them a funded account — still simulated — where they keep 80% of profit, paid weekly.

Every account on the platform is simulated. No real orders reach a market, PFT is not a broker and
holds no client funds. This is stated in `/legal/terms` and in the risk disclosure.

The product's market position is being the cheapest challenge on the market, which is why honesty
about numbers is the product itself. Do not invent figures anywhere — not in copy, not in tests, not
in seed data.

## 0.2 Where the terminal lives

```
app/dashboard/terminal/page.tsx        route shell
components/terminal/TerminalShell.tsx  page frame
components/terminal/TerminalWorkspace.tsx  layout: chart + order panel + positions
components/terminal/TradingChart.tsx   the chart (1,191 lines — this is the file you will touch)
components/terminal/OrderPanel.tsx     order ticket (DO NOT TOUCH)
components/terminal/PositionsTable.tsx open positions (DO NOT TOUCH)
components/terminal/ChartDrawingToolbar.tsx  drawing tools + templates
components/terminal/TerminalHeader.tsx account header, timezone picker
lib/stores/useChartLayoutStore.ts      drawings + templates (zustand, localStorage-backed)
lib/stores/useTradingStore.ts          symbol, live price, connection status
lib/stores/useOrderTicketStore.ts      order ticket draft state (DO NOT TOUCH)
```

## 0.3 How the chart is built

`lightweight-charts` v5 (the `addSeries(lc.CandlestickSeries, …)` API, not the removed
`addCandlestickSeries`). The chart instance lives in `chartRef`, the candle series in
`seriesRef.current.candle`. Two coordinate helpers already exist and you will need both:

```ts
// container-relative pixel → price
seriesRef.current?.candle.coordinateToPrice(y)
// container-relative pixel → unix seconds
chartRef.current?.timeScale().coordinateToTime(x)
```

The chart container is this div inside `TradingChart`:

```tsx
<div className="relative min-h-[240px] flex-1">
  <div ref={containerRef} className="absolute inset-0" />
  …overlays: notices, drawing SVG (z-5), drawing capture layer (z-12), level sliders (z-10),
   ChartDrawingToolbar, "collecting" overlay…
</div>
```

Everything above the canvas is an overlay. Keep that in mind in Part 1.3 — a right-click must work
over the plot, not over the toolbar.

Existing drawing tools: trend, horizontal, rectangle, Fibonacci. They are stored per symbol in
`useChartLayoutStore` as `drawingsBySymbol[symbol]`, each with `{ id, type, points, color, createdAt }`.
The store already exposes `removeLast` and `clearDrawings` but **not** removing one specific drawing.

## 0.4 Invariants you must not break

1. **Money is `Prisma.Decimal`.** Never `number` in a database write for money or price. Prices in
   this feature are prices, not money, but they still go through `Prisma.Decimal` because they are
   compared against live quotes.
2. **Fail closed on anything financial.** Payments, payouts and KYC abort on doubt. Analytics and
   notifications fail open. Your alerts sit in the notification bucket: a failed email must never
   break the trading page or the cron run, but it must also never send twice.
3. **No new npm dependencies.** Everything you need is installed.
4. **Do not change the database schema and then push it.** You may edit `prisma/schema.prisma` and
   run `npx prisma generate` locally. Running `prisma db push` is the owner's step — see 3.4.
5. **TypeScript and ESLint must be clean.** `npx tsc --noEmit` and `npx eslint <files>`.
6. **Do not restyle the terminal.** Reuse the existing tokens (`bg-[#0b1122]`, `border-border`,
   `font-mono`, `text-muted-foreground`, `text-primary`, `text-danger`). The chart is a dense dark UI;
   a foreign-looking menu will be rejected.

## 0.5 How to run and check your work

```bash
npm run dev                 # http://localhost:3000
npx tsc --noEmit            # must be silent
npx eslint components/terminal lib/stores app/api/trading/alerts
npm run build               # must complete; it now runs `prisma generate` first
```

To reach the terminal you need a trader session. Without `DATABASE_URL` the app runs in demo mode and
`demo@pft.local` works; with a database, use any ACTIVE test account.

---

# Part 1 — Chart context menu

## 1.1 Scope

- The menu exists **only on the chart**. Not on the header, not on the order panel, not on the
  positions table, not globally.
- It opens **only on right mouse button** (`contextmenu` event) inside the chart plot area.
- **Desktop only.** There is no mobile app yet; do not add long-press, do not add a mobile variant.
- Every menu item affects **chart state only**, with one deliberate exception: the alert item opens a
  dialog (Part 2). It never places or modifies an order.

## 1.2 Files

| File | Action |
|---|---|
| `components/terminal/ChartContextMenu.tsx` | **new** — the menu component |
| `components/terminal/TradingChart.tsx` | add the trigger, position state, item handlers |
| `lib/stores/useChartLayoutStore.ts` | add `removeDrawing(symbol, id)` |

Nothing else. Do not touch `OrderPanel.tsx`, `PositionsTable.tsx`, `TerminalHeader.tsx`.

## 1.3 Behaviour

**Opening.** Attach `onContextMenu` to the plot wrapper (the `relative min-h-[240px] flex-1` div).
Add `data-chart-surface` to that wrapper and `data-chart-ui` to the drawing toolbar and to the notice
toasts. In the handler: if `event.target.closest('[data-chart-ui]')` exists, return without doing
anything. Otherwise `event.preventDefault()` and open the menu at the pointer.

**Coordinates.** Compute `x`/`y` relative to the wrapper via `getBoundingClientRect()`, not
`clientX/clientY`. Resolve `price = seriesRef.current.candle.coordinateToPrice(y)` and
`time = chartRef.current.timeScale().coordinateToTime(x)`. Both can return `null` — if price is null,
do not open the menu at all (the pointer is outside the price scale).

**Placement.** The menu is `position: absolute` inside the wrapper. After mount, measure it and clamp
so it never overflows the wrapper: flip horizontally when `x + width > wrapperWidth`, flip vertically
when `y + height > wrapperHeight`. Keep an 8px gutter.

**Dismissal.** Close on: `Escape`, pointerdown outside the menu, `window` scroll (capture phase),
`window` resize, `blur`, and after any item is chosen.

**Keyboard and a11y.** `role="menu"` on the container, `role="menuitem"` on each row. Arrow up/down
move focus, `Home`/`End` jump, `Enter`/`Space` activate, `Escape` closes and returns focus to the
wrapper (give the wrapper `tabIndex={-1}`). Focus the first item on open. Items that are unavailable
must be `aria-disabled` and skipped by arrow navigation, not hidden.

**Double right-click opens the browser menu.** This is a deliberate escape hatch so the user can still
reach "Inspect" and "Save image". Track the timestamp of the last handled right-click. If a second
`contextmenu` arrives within **400 ms**, do **not** call `preventDefault()`, and close our menu if it
is open — the browser shows its own menu. Implement this in the same handler; no timers that mutate
state after unmount.

## 1.4 Menu items

Order matters — this is the agreed list.

| Item | Enabled when | Behaviour |
|---|---|---|
| `Copy price` | price resolved | `navigator.clipboard.writeText(formatPrice(symbol, price))`. On success show a short inline confirmation inside the menu (`role="status"`, auto-close after ~1.2 s). On failure (insecure context, denied permission) fall back to a `document.execCommand('copy')` textarea trick; if that also fails, close and show the existing `levelNotice` with tone `error`. |
| `Add alert at this price` | price resolved | Opens `PriceAlertDialog` (Part 2) prefilled with the symbol and the resolved price. |
| `Reset chart view` | always | `chartRef.current?.timeScale().fitContent()`, then close. |
| `Remove drawing` | `drawings.length > 0` | Expands into a list of the current symbol's drawings (see 1.5). |
| `Clear all drawings` | `drawings.length > 0` | `clearDrawings(symbol)`, close. |

`formatPrice` comes from `@/lib/constants/symbols`. Use it — it knows each symbol's decimals.

Do **not** add: sell/buy at price, add order at price, paste, table view, settings, indicators,
lock cursor line. They were explicitly excluded.

## 1.5 The drawing list (object tree)

When `Remove drawing` is expanded, render one row per drawing of `selectedSymbol`:

```
[colour swatch]  Trend line        ⌫
[colour swatch]  Horizontal 1.0842 ⌫
```

- Type label: `trend` → "Trend line", `horizontal` → "Horizontal", `rectangle` → "Rectangle",
  `fib` → "Fibonacci". For `horizontal`, append the price from `points[0].price` formatted with
  `formatPrice`.
- Swatch uses `drawing.color` from the store.
- The `⌫` button calls `removeDrawing(symbol, drawing.id)`.
- Newest first.
- When the list becomes empty, collapse back to the parent item.

**Store change** in `lib/stores/useChartLayoutStore.ts`:

```ts
removeDrawing: (symbol: string, id: string) => void
```

Implementation mirrors `removeLast`: read `{ drawingsBySymbol, templates }`, filter out the id, call
`persist(next, templates)`, `set({ drawingsBySymbol: next })`. Persist must stay best-effort — the
existing `persist` already swallows storage errors, keep that.

## 1.6 Acceptance for Part 1

- Right-click on the plot opens the menu at the pointer; right-click on the toolbar does nothing.
- The menu stays inside the chart at every edge (test all four corners and a 400px-wide window).
- Copy price puts `1.08423` (symbol-appropriate decimals) on the clipboard.
- Reset view brings back the last 140 bars after scrolling into empty space.
- A drawing can be removed by id; the change survives a page reload (localStorage).
- Two right-clicks within 400 ms open the **browser** menu, and our menu is closed.
- `Escape` closes the menu and focus returns to the chart.
- Keyboard-only: `Tab` to the chart, `Shift+F10` is **not** required, but arrow navigation inside the
  open menu works.
- No console errors when the chart is destroyed while the menu is open.

---

# Part 2 — Price alerts with email

The trader right-clicks a level on the chart, creates an alert, and receives **one email** when the
price crosses that level. The email must be sent even if the browser tab is closed — that is the whole
point, which is why this is server-side and not a browser `Notification`.

## 2.1 Data model

Add to `prisma/schema.prisma`:

```prisma
/// A chart-created price threshold. Evaluated by a cron against live quotes; the
/// owner is emailed once, when the price crosses it.
model PriceAlert {
  id          String    @id @default(cuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  symbol      String
  /// ABOVE | BELOW — the side the price has to cross.
  direction   String
  price       Decimal   @db.Decimal(18, 5)
  /// ACTIVE | TRIGGERED | CANCELLED
  status      String    @default("ACTIVE")
  /// Last quote the evaluator saw, kept for the email and for support.
  lastPrice   Decimal?  @db.Decimal(18, 5)
  /// Delivery attempts. Capped at 3 so a broken mailer cannot loop forever.
  attempts    Int       @default(0)
  createdAt   DateTime  @default(now())
  triggeredAt DateTime?
  notifiedAt  DateTime?

  @@index([status, symbol])
  @@index([userId, status])
}
```

Add the back-relation on `model User`: `priceAlerts PriceAlert[]`.

Then run `npx prisma generate` (the build script already does this too).

## 2.2 API

All routes are trader-authenticated. Copy the pattern from `app/api/trading/quotes/route.ts`:
`const { session, error } = await requireTrader(); if (error) return error`.

`app/api/trading/alerts/route.ts`

- `GET` → active alerts of `session.sub`, newest first, max 50.
- `POST` body `{ symbol, price, direction }`:
  - validate: symbol in `TERMINAL_SYMBOLS` (`@/lib/constants/symbols`), `direction` is `ABOVE` or
    `BELOW`, price is a finite number `> 0`;
  - reject when the trader already has **20** ACTIVE alerts (`400`, message
    `"You can have at most 20 active alerts."`);
  - rate limit with `reserveRateLimit('alerts:create:<userId>', 10, 60_000)` from
    `@/lib/security/rate-limit-store` — on `count > 10` return `429`;
  - create with `new Prisma.Decimal(price)`, return the row.
- Response shape: `{ alerts: [...] }` with `price` serialised as a `number`, `createdAt` as ISO.

`app/api/trading/alerts/[id]/route.ts`

- `DELETE` → cancel an alert that belongs to `session.sub` and is still `ACTIVE`
  (`updateMany` with `{ id, userId, status: 'ACTIVE' }`, `data: { status: 'CANCELLED' }`).
  `404` when nothing was updated.

Do not expose another trader's alerts under any circumstance: every query is scoped by `userId`.

## 2.3 Evaluation cron

`app/api/alerts/check/route.ts`, `export const dynamic = 'force-dynamic'`.

**Authorisation** — copy the `authorized(request)` helper from
`app/api/stats/recalculate/route.ts`: accept `Authorization: Bearer <CRON_SECRET>` via
`safeSecretEqual`, otherwise require an admin session.

**Algorithm**

1. Load at most 200 alerts: `status = 'ACTIVE'` or (`status = 'TRIGGERED'` and `notifiedAt = null` and
   `attempts < 3`).
2. Collect distinct symbols, call `getQuoteSnapshots(symbols)` from `@/lib/trading/market-quotes`.
   It already drops stale quotes and closed index markets — a symbol missing from the result means
   "no trustworthy price right now", so **skip** its alerts this run. Never evaluate against a stale
   price.
3. For each alert with a quote, use `quote.mid`. Trigger when
   `direction === 'ABOVE' ? mid >= price : mid <= price`.
4. **Claim atomically before sending**:
   ```ts
   const claimed = await prisma.priceAlert.updateMany({
     where: { id: alert.id, status: 'ACTIVE' },
     data: { status: 'TRIGGERED', triggeredAt: new Date(), lastPrice: new Prisma.Decimal(mid) },
   })
   if (claimed.count === 0) continue   // another run already took it
   ```
   This is the only thing standing between a retry and a duplicate email. Do not replace it with
   read-then-write.
5. Send the email (2.4). On success set `notifiedAt`. On failure `attempts: { increment: 1 }` and log
   with `console.error('[pft alerts] …')` — the row stays `TRIGGERED` with `notifiedAt: null` and the
   next run retries, at most three times.
6. Return `{ checked, triggered, sent, failed }` as JSON. Never throw on a per-alert failure.

**Schedule** in `vercel.json`:

```json
{ "path": "/api/alerts/check", "schedule": "* * * * *" }
```

Per-minute crons require a Vercel Pro plan. If the project is on Hobby the deploy will reject this
schedule — **report that to the owner instead of quietly changing the frequency or moving the check
into the browser.**

## 2.4 Email

New module `lib/email/price-alert.ts`, modelled on `lib/email/breach-notice.ts`:

```ts
import { sendEmail } from './resend'
import { emailRows, escapeHtml, pftEmailShell } from './pft-email'

export async function sendPriceAlert(input: {
  to: string; name: string; symbol: string; direction: 'ABOVE' | 'BELOW'
  target: string; actual: string; alertId: string
}) { … }
```

- Subject: `Price alert · EURUSD above 1.08420`.
- Body: `pftEmailShell({ tone: 'info', title, body, cta: { label: 'Open terminal', url: `${appUrl()}/dashboard/terminal` } })`
  plus `emailRows([['Symbol', …], ['Condition', …], ['Target', …], ['Price now', …]])`.
- `idempotencyKey: \`price-alert-${input.alertId}\`` — Resend deduplicates on it, which is the second
  line of defence behind the atomic claim.
- Prices formatted with `formatPrice(symbol, value)`.
- `sendEmail` returns `{ status }`; treat `SKIPPED` as a failure for retry purposes and log why.

Never put a raw trader email or a price series into `console.log`.

## 2.5 Dialog

`components/terminal/PriceAlertDialog.tsx`, opened from the menu item in 1.4. Use the existing
`Dialog` primitives (`@/components/ui/dialog`), the way `ResetAccountDialog.tsx` does.

- Fields: symbol (read-only), **price** (number input, prefilled from the click, editable, validated
  against the symbol's decimals), **direction** (two-option toggle "Above" / "Below"), and a read-only
  line `We will email you at <account email>`.
- Below the form, list the trader's active alerts for this symbol with a cancel button each, loaded
  from `GET /api/trading/alerts`.
- Submit → `POST`, then close and show the existing `levelNotice` with tone `ok` and text
  `Alert created · EURUSD above 1.08420`.
- Errors render inline in the dialog, never as an alert dialog.
- Loading and disabled states while the request is in flight; no double submit.

## 2.6 Acceptance for Part 2

- Creating an alert from the chart persists a row with the right `symbol`, `direction` and `price`.
- A trader cannot read or cancel another trader's alert (`404` / empty list).
- The 21st active alert is rejected with a readable message.
- With `direction = ABOVE` and a target **below** the current mid, the next cron run triggers it
  exactly once — one row moves to `TRIGGERED`, one email leaves.
- Running the cron twice in a row sends **one** email, not two.
- With the mailer misconfigured, the alert stays `TRIGGERED`, `attempts` increments, and after three
  runs it stops retrying. No crash, no 500 from the cron.
- An alert on a symbol with no fresh quote is skipped, not triggered.
- `npx tsc --noEmit` silent, `npm run build` green.

---

# Part 3 — Verification and handover

## 3.1 Self-check before you report

```bash
npx tsc --noEmit
npx eslint components/terminal lib/stores app/api/trading/alerts lib/email/price-alert.ts
npm run build
```

## 3.2 Manual test script

1. `npm run dev`, sign in, open `/dashboard/terminal`.
2. Right-click mid-chart → menu at pointer. Right-click the drawing toolbar → nothing.
3. Copy price → paste somewhere and compare with the axis.
4. Scroll the chart into empty space, right-click → Reset chart view → last bars return.
5. Draw a trend line, right-click → Remove drawing → pick it → gone after reload.
6. Two quick right-clicks → browser menu appears.
7. Right-click → Add alert → create `ABOVE` with a target below the current price.
8. Run the cron locally:
   `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/alerts/check`
   → `triggered: 1`; check the inbox (or Mailpit at the dev transport URL).

## 3.3 What to report back

- Files changed, one line each.
- The exact commands you ran and their result.
- Anything you could not verify and why.
- Anything in this brief that turned out to be wrong — say so instead of improvising around it.

## 3.4 Do not run `prisma db push`

You may edit the schema and run `npx prisma generate`. Applying it to a database is the owner's step:
production and preview use **different** `DATABASE_URL` values, and pushing to the wrong one has
already caused one silent outage. State clearly in your report that `PriceAlert` needs a push.

---

# Part 4 — Out of scope (do not build, do not "improve")

- Mobile or touch behaviour of the menu. No long-press.
- Placing, modifying or cancelling orders from the chart menu.
- Indicators of any kind, table view, data window, chart settings panel, paste, lock cursor line.
- Rebuilding chart templates — they already exist in `ChartDrawingToolbar`.
- Changing `OrderPanel`, `PositionsTable`, `TerminalHeader`, the drawing toolbar layout, or the
  marketing analytics allowlist in `lib/analytics/events.ts`.
- New npm packages.
- Any new copy on the marketing pages.
