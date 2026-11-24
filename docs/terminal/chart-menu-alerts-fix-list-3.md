# Fix list — round 3: close the duplicate-email hole

**Repo:** `C:\Users\User\Documents\Типовий проєкт`
**Branch:** `staging/ai-support-reliability`

Round 2 verified: all fifteen items from `chart-menu-alerts-fix-list.md` are in the code, `tsc` clean,
`eslint` 0 errors, `npm run build` green. Three items remain. R1 is the only one that can put a second
email in a trader's inbox, so it must land before this reaches production.

---

## R1 — BLOCKER: two cron runs can both send the retry email

`app/api/alerts/check/route.ts`

Two separate holes that combine into one.

**Hole 1 — the concurrency guard is ignored.** `claimExecution` returns
`{ claimed: false, action: 'CONCURRENT' }` when a peer run holds the lease (see
`ClaimExecutionResult` in `lib/ops/observability.ts:599`). The route only reads `claim.claimed` inside
`finally`, so a second run proceeds and evaluates the same rows anyway.

Right after the claim (line ~54, before `let checked = 0`):

```ts
if (!claim?.claimed) {
  return NextResponse.json({ skipped: 'concurrent' })
}
```

Keep the existing `finally` logic — it already checks `claim.claimed` before calling
`finishExecution`, and that stays correct.

**Hole 2 — the retry claim is not exclusive.** Line ~133:

```ts
retry = await prisma.priceAlert.updateMany({
  where: { id: alert.id, status: 'TRIGGERED', notifiedAt: null, attempts: { lt: 3 } },
  data: { attempts: { increment: 1 } },
})
```

`attempts < 3` matches for every concurrent run, so all of them get `count: 1` and all of them send.
Make it a compare-and-set on the value this run actually read:

```ts
retry = await prisma.priceAlert.updateMany({
  where: {
    id: alert.id,
    status: 'TRIGGERED',
    notifiedAt: null,
    attempts: alert.attempts,          // ← the value this run saw
  },
  data: { attempts: { increment: 1 } },
})
```

Only one run can transition `attempts: n → n+1`; every other run sees `count: 0` and skips. Keep the
`attempts < 3` bound in the **query** that loads candidates (line ~40) so the cap still holds.

**Why both.** Hole 1 alone would be enough while the lease is honoured, but the lease can expire and a
takeover run can start while the first is still finishing a slow send. Hole 2 is what makes the send
single-shot regardless of who is running.

**Acceptance:**
- Two simultaneous `curl`s against `/api/alerts/check` with a due retry row → exactly one email, one
  `attempts` increment, the other request answers `{ skipped: 'concurrent' }`.
- One run with the mailer broken → `attempts` goes 0 → 1 → 2 → 3 across four runs, then the row stops
  being loaded.
- Normal single-run path unchanged: one email per alert, `notifiedAt` set.

---

## R2 — focus is returned to an element that cannot take it

`components/terminal/TradingChart.tsx:1225`

```ts
containerRef.current?.focus()
```

`containerRef` is the inner canvas div (`<div ref={containerRef} className="absolute inset-0" />`) — it
has no `tabIndex`, so `.focus()` is a silent no-op. The focusable element is the wrapper at line
1127-1129 (`data-chart-surface`, `tabIndex={-1}`).

Add a ref to that wrapper and focus it instead. Do not add `tabIndex` to the canvas div — the wrapper is
already the intended focus target and is what `ChartSettingsSurface` uses.

**Acceptance:** open the menu, press `Escape` — focus lands on the chart wrapper
(`document.activeElement` has `data-chart-surface`), and the next `Tab` leaves the chart rather than
starting from the top of the page.

---

## R3 — the clamp is not recomputed when the menu grows

`components/terminal/ChartContextMenu.tsx:221`

```ts
}, [open, x, y, wrapperRef])
```

Expanding `Delete a drawing` adds one row per drawing. Near the bottom edge the menu then grows past the
wrapper and is clipped by the section's `overflow-hidden`, because the measure/flip effect never re-runs.

Add the expansion state to the dependencies (and, since the list length matters too, the drawing count):

```ts
}, [open, x, y, wrapperRef, expandedDelete, drawings.length])
```

**Acceptance:** with four drawings, open the menu in the bottom-right corner and expand
`Delete a drawing` — the whole list stays inside the chart with the 8px gutter, flipping upwards.

---

## R4 — tiny: mixed width sources in the same clamp

`components/terminal/ChartContextMenu.tsx`, the clamp effect

`baseX` is computed from `wrapper.clientWidth` / `wrapper.clientHeight`, while the flip uses
`wrapperRect.width` / `wrapperRect.height`. Those differ by the border and any scrollbar. Pick one —
`wrapperRect.width` / `wrapperRect.height` — for both.

No acceptance test beyond R3's corner case still passing.

---

## Definition of done

```bash
npx tsc --noEmit
npx eslint components/terminal app/api/alerts
npm run build
```

Then, with the `PriceAlert` table pushed **locally only** (the owner does the real push):

1. Create an alert, break the mailer, run the cron four times → `attempts` reaches 3 and stops.
2. Fire two cron requests in parallel → one email, one `attempts` increment, one `skipped: concurrent`.
3. `Escape` on the open menu → focus is on `[data-chart-surface]`.
4. Bottom-right corner, expand the drawing list → menu stays inside the chart.

**Do not:** push to git, run `prisma db push` against production or preview, touch the order panel, or
add anything to `Chart settings`.
