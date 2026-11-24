# Fix list — chart context menu and price alerts (round 2)

**Repo:** `C:\Users\User\Documents\Типовий проєкт`
**Branch:** `staging/ai-support-reliability`
**Read first:** `docs/terminal/chart-context-menu-and-alerts-worker-brief.md` — this list only corrects
what the first round got wrong. Everything in the brief still applies.

Verified on your first round: `npx tsc --noEmit` clean, `eslint` 0 errors, `npm run build` green,
`prisma db push` correctly **not** run. Good. The problems below are behavioural.

Fix them in the order given. F1 and F2 are blockers — the feature does not work at all without them.

---

## F1 — BLOCKER: the dialog rejects the price it prefilled

`components/terminal/PriceAlertDialog.tsx:97-101`

```ts
function priceIsValid(value: string): boolean {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return false
  const step = 10 ** -decimals
  return (parsed / step) % 1 === 0     // ← never true for most prices
}
```

Float modulo. Measured on the current code with `decimals = 5`:

| Input | Result |
|---|---|
| `1.0842` | **rejected** (`1.0842 / 1e-5 = 108420.00000000001`) |
| `1.08423` | **rejected** |
| `0.64512` | **rejected** |
| `1.08425` | accepted |

And the price handed over from the chart is `coordinateToPrice(y)`, i.e. `1.0842345678…` — so the
main flow ("right-click → Notify me at this level → Create") fails validation every single time.

**Fix, both halves:**

1. When the dialog opens, round the incoming price to the symbol's decimals before putting it in the
   field: `setFormPrice(price.toFixed(decimals))`.
2. Validate by comparing against the rounded value, not by modulo:

```ts
const rounded = Number(parsed.toFixed(decimals))
return Math.abs(parsed - rounded) < 1e-9
```

**Acceptance:** `1.0842`, `1.08423`, `0.64512` pass for a 5-decimal symbol; `1.084234` is rejected
with the message; a price taken straight from a chart click passes without editing.

---

## F2 — BLOCKER: the retry path is dead

`app/api/alerts/check/route.ts:33-79`

The query loads rows that need a retry:

```ts
OR: [
  { status: 'ACTIVE' },
  { status: 'TRIGGERED', notifiedAt: null, attempts: { lt: 3 } },
]
```

but the claim only ever matches `ACTIVE`:

```ts
const claimed = await prisma.priceAlert.updateMany({
  where: { id: alert.id, status: 'ACTIVE' },
  …
})
if (claimed.count === 0) continue
```

For a `TRIGGERED` row `count` is always 0, so every retry candidate is loaded and thrown away. A
failed email is lost forever, and the three-attempt cap can never be reached.

**Fix:** claim each of the two states on its own terms, and send when either claim succeeded.

```ts
// Fresh trigger.
const fresh = await prisma.priceAlert.updateMany({
  where: { id: alert.id, status: 'ACTIVE' },
  data: { status: 'TRIGGERED', triggeredAt: new Date(), lastPrice: new Prisma.Decimal(mid) },
})

// Retry of a trigger whose email never left.
const retry =
  fresh.count === 0
    ? await prisma.priceAlert.updateMany({
        where: { id: alert.id, status: 'TRIGGERED', notifiedAt: null, attempts: { lt: 3 } },
        data: { attempts: { increment: 1 } },
      })
    : { count: 0 }

if (fresh.count === 0 && retry.count === 0) continue
```

Keep `attempts` incremented **once per attempt**, and keep the `attempts < 3` filter so a broken
mailer cannot loop forever. Do not send for a row whose `attempts` is already 3.

**Acceptance:** with `RESEND_API_KEY` unset, run the cron four times — `attempts` reaches 3, then the
row drops out of the query and stops being attempted. Set the key, run again — one email, and
`notifiedAt` is set. Running the cron twice in the same minute never produces two emails.

---

## F3 — the menu never applies its edge clamp

`components/terminal/ChartContextMenu.tsx:196-210` and `:353`

The clamp result is written into `positionRef.current` inside a `requestAnimationFrame`, but nothing
re-renders afterwards, so `style={{ left: positionRef.current.x, … }}` keeps the pre-clamp values.
The menu opens at the pointer but is **clipped at the right and bottom edges** by the section's
`overflow-hidden`.

**Fix:** keep the position in state.

```ts
const [pos, setPos] = useState({ x, y })
// base position on open, then measure and flip inside rAF with setPos
```

Render from `pos`. Make sure the effect re-runs when `x`, `y` or `open` change.

**Acceptance:** right-click in each of the four corners of the plot and at a 400px window width —
the menu stays fully visible with an 8px gutter on every side.

---

## F4 — right-clicking inside the open menu re-opens it

`components/terminal/ChartContextMenu.tsx:347` and `components/terminal/TradingChart.tsx:1027-1033`

The menu calls `preventDefault()` on `contextmenu` but does not stop propagation, and it has no
`data-chart-ui`, so the chart's handler runs too: it moves the menu to the new point and re-opens it.

Second problem in the same handler: `lastRightClickRef.current = now` is written **before** the
`[data-chart-ui]` check, so a right-click on the drawing toolbar poisons the double-click window and
the next right-click on the plot opens the browser menu instead of ours.

**Fix:**
1. Add `data-chart-ui` to the menu root (line 347).
2. In `TradingChart.tsx`, move the `closest('[data-chart-ui]')` check to the top of the handler, above
   the `lastRightClickRef` bookkeeping.

**Acceptance:** right-click inside an open menu does not move it; right-click on the toolbar, then
immediately on the plot, opens our menu.

---

## F5 — the alert list ignores the symbol

`components/terminal/PriceAlertDialog.tsx:60` sends `?symbol=…`, `app/api/trading/alerts/route.ts:10`
ignores it and returns every active alert of the trader. The block is labelled "Active alerts for
EURUSD" while listing alerts for all symbols.

**Fix:** read the query param in the GET handler (`new URL(request.url).searchParams.get('symbol')`),
validate it against `TERMINAL_SYMBOLS`, and add it to the `where` when present.

**Acceptance:** two alerts on different symbols → each dialog shows only its own.

---

## F6 — round the menu corners

`components/terminal/ChartContextMenu.tsx:350`

The menu is a hard-edged rectangle. Give it the same shape language as the rest of the app — the
dropdown in `components/ui/dropdown-menu.tsx` uses `rounded-lg` on the popup and `rounded-md` on the
items.

- Add `rounded-lg` **and** `overflow-hidden` to the menu root. `overflow-hidden` is required: without
  it the hover background of the first and last items paints square corners over the radius.
- Keep `border border-border`; a hairline highlight reads well on the dark surface
  (`ring-1 ring-white/10` is acceptable in addition, not instead).
- Do not round the separators — they are 1px lines inside the clipped container.
- Do not change the item paddings to make room for rounding; the clip is enough.

**Acceptance:** at 100% zoom the corners are visibly rounded (~8px), the hover highlight follows the
curve on the first and last rows, nothing is clipped mid-glyph, and the menu still measures correctly
for the F3 clamp.

---

## F7 — settings surface: role and a focus bug

`components/terminal/ChartSettingsSurface.tsx:24-30` and `:50`

1. The container has no `role="dialog"` and no `aria-labelledby`, both required by the brief. The
   title already has `id="chart-settings-title"` — wire it up.
2. The focus-return effect runs on mount as well (`open === false` at first render), so loading the
   terminal steals focus into the chart container. Guard it with a `wasOpenRef` that only returns
   focus after the surface has actually been open.

**Acceptance:** the surface is announced as a dialog; loading `/dashboard/terminal` does not move
focus; opening and closing it returns focus to the chart.

---

## F8 — disabled items still run

`components/terminal/ChartContextMenu.tsx`, the item `onClick`

`item.action()` fires regardless of `item.enabled`. Disabled rows are styled as disabled and carry
`aria-disabled`, but they still act.

**Fix:** `onClick={() => { if (!item.enabled) return; item.action() }}` — and the same guard in the
`Enter`/`Space` handler.

---

## F9 — the "Copied" confirmation is never seen

`components/terminal/ChartContextMenu.tsx:296-322`

`handleCopyLevel` calls `onClose()` immediately after a successful copy, so the 1.2s badge the brief
asked for cannot render. Close on a timer instead (`COPY_CONFIRM_MS`), and clear that timer on
unmount — the ref is already there.

**Acceptance:** copying shows "Copied" for ~1.2s inside the menu, then the menu closes.

---

## F10 — the drawing list stays expanded

`components/terminal/ChartContextMenu.tsx:69`

`expandedDelete` is component state that survives closing the menu, so it reopens already expanded.

**Fix:** reset it when `open` goes false.

---

## M — small consistency items (cheap, do them in the same pass)

| # | Where | What |
|---|---|---|
| M1 | `components/terminal/TradingChart.tsx:1049` | `chart.timeScale().coordinateToTime(x)` is called and the result discarded. Delete the line (line 818 is pre-existing code — leave it). |
| M2 | `app/api/trading/alerts/route.ts` POST | Returns `{ alerts: [ … ] }`, while the dialog types the response as `{ alert }`. Return `{ alert }` from POST, keep `{ alerts }` for GET, and update the dialog's type. |
| M3 | `app/api/trading/alerts/route.ts` POST | `reserveRateLimit` is not wrapped in `try/catch`; every other caller guards it (`app/api/events/route.ts`). If the limiter is unavailable the request must continue, not 500. |
| M4 | `app/api/alerts/check/route.ts` | The new cron has no ops heartbeat. `/api/stats/recalculate` registers a component and writes heartbeats via `lib/ops/observability`; without it this job is invisible on the ops desk. Follow that file's pattern. |
| M5 | `components/terminal/ChartContextMenu.tsx` | On close, focus is not returned to the chart wrapper, which the brief lists as acceptance. |

---

## Definition of done

```bash
npx tsc --noEmit
npx eslint components/terminal app/api/trading/alerts app/api/alerts lib/email/price-alert.ts
npm run build
```

Manual pass, in this order:

1. Right-click each corner of the plot → menu fully visible, rounded corners, hover follows the curve.
2. Right-click inside the open menu → nothing moves. Right-click the toolbar → nothing opens.
3. Two right-clicks within 400ms → browser menu. Toolbar click, then plot click → our menu.
4. `Copy level` → "Copied" for a moment, then closes; clipboard has the right decimals.
5. Draw two lines → `Delete a drawing` → delete one → survives reload.
6. `Chart settings` → empty surface, `Escape` closes, focus returns to the chart.
7. `Notify me at this level` → the prefilled price is accepted **without editing**.
8. Two alerts on different symbols → each dialog lists only its own.
9. Cron with the mailer broken: 4 runs → `attempts` 3, then no more attempts.
10. Cron with the mailer working: one email, `notifiedAt` set, second run sends nothing.

**Do not:** run `prisma db push`, push to git, touch `OrderPanel` / `PositionsTable` / `TerminalHeader`,
add mobile/touch handling, or add anything to `Chart settings` beyond the empty shell.
