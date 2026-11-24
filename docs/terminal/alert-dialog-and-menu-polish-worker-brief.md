# Worker brief — alert dialog + chart menu polish

**Repo:** `C:\Users\User\Documents\Типовий проєкт`
**Branch:** `staging/ai-support-reliability` (push there; `main` is fast-forwarded separately)
**Commit baseline:** `f04e1d8`

Three items. One is a blocker that makes half the alert feature unusable, two are visual.
Do them in this order.

---

## Part 0 — Context for someone who has not seen this code

The terminal is a Next.js 16 App Router app. The chart lives in
`components/terminal/TradingChart.tsx` (lightweight-charts v5). Right-clicking the chart opens
`components/terminal/ChartContextMenu.tsx`. One of its items opens
`components/terminal/PriceAlertDialog.tsx`, which POSTs to `/api/trading/alerts`.

State is Zustand (`lib/stores/*`). **Never build a new array or object inside a store selector** —
`useSyncExternalStore` compares snapshots with `Object.is`, so `?? []` inside a selector loops until
React throws "Maximum update depth exceeded" and unmounts the page. That exact mistake took the
terminal down in `3289541`; it was fixed in `f04e1d8` by hoisting `EMPTY_DRAWINGS`. Do not
reintroduce it.

Commands:

```powershell
npx tsc --noEmit
npx eslint components/terminal
npm run build
```

`npm run dev` needs `.env.local` (preview Neon branch). The production database is a different
branch; `PFT_PROD_DATABASE_URL` lives in `.env.production.local`. Do not run `prisma db push`
against production — see `docs/PFT-production-rollout.md` §2.

---

## Part 1 — BLOCKER: the "Below" button cannot be selected

`components/terminal/PriceAlertDialog.tsx`, lines 78–85.

### Symptom

Open the alert dialog, click **Below**. It flashes and reverts to **Above**. The trader cannot create
a downward alert at all.

### Root cause

```ts
// line 48 — a plain function, recreated on every render
async function loadAlerts() { … }

// lines 78–85
useEffect(() => {
  if (!open) return
  setFormSymbol(symbol)
  setFormPrice(price.toFixed(decimals))
  setDirection('ABOVE')   // ← this runs after every render
  setError(null)
  void loadAlerts()
}, [open, symbol, price, decimals, loadAlerts])
```

`loadAlerts` is a new function identity on every render, so it is a changed dependency on every
render. The effect therefore runs after every render and resets `direction` to `'ABOVE'`:

1. click Below → `setDirection('BELOW')`
2. re-render with `direction === 'BELOW'`
3. effect fires (deps changed because `loadAlerts` is new) → `setDirection('ABOVE')`
4. re-render → effect fires again → …

Step 4 also means **an unbounded GET loop** on `/api/trading/alerts` while the dialog is open. That is
the `net::ERR_ABORTED` noise in the console, and it hammers the rate limiter.

### Required fix

Two effects, each with a stable dependency list, and a reset that fires only on the open transition.

```ts
const loadAlerts = useCallback(async () => {
  // … unchanged body …
}, [formSymbol])

// Reset the form once per opening, never on re-render.
const wasOpen = useRef(false)
useEffect(() => {
  if (!open) {
    wasOpen.current = false
    return
  }
  if (wasOpen.current) return
  wasOpen.current = true
  setFormSymbol(symbol)
  setFormPrice(price.toFixed(decimals))
  setDirection('ABOVE')
  setError(null)
}, [open, symbol, price, decimals])

// Reload the list when the symbol changes or the dialog opens.
useEffect(() => {
  if (!open) return
  void loadAlerts()
}, [open, loadAlerts])
```

Notes:

- `loadAlerts` is also called from `cancelAlert`; `useCallback` keeps that working.
- Do **not** solve this by removing `loadAlerts` from the deps and adding an eslint-disable. The
  reset must not run on re-render, and the list must still reload when `formSymbol` changes.
- `setFormSymbol(symbol)` inside the reset effect changes `loadAlerts` identity, so the second
  effect refetches once. That is correct and happens once per opening.

### Acceptance — prove it, do not assume

1. Open the dialog, click **Below**. It stays selected. Click **Above**, it stays selected. No
   flicker.
2. With the dialog open and idle, the Network panel shows **one** `GET /api/trading/alerts?symbol=…`.
   Not a stream.
3. Create a real BELOW alert. The POST body must carry `"direction":"BELOW"`, and the new row must
   render in the "Active alerts" list with the word `Below`.
4. Confirm in the database that the row really is BELOW:
   ```sql
   SELECT id, symbol, direction, price, status FROM "PriceAlert" ORDER BY "createdAt" DESC LIMIT 3;
   ```
5. The `Create alert` button is disabled while the price is invalid and enabled once it is valid —
   unchanged behaviour, must still hold.

---

## Part 2 — Add the "PFT // TERMINAL" header to the context menu

`components/terminal/ChartContextMenu.tsx`, the menu root (around line 368).

The reference is the sidebar brand in `components/dashboard/sidebar.tsx:28-46` — an orbital mark plus
`PFT // TERMINAL`. The menu needs the same header as its first row, above the first item.

### Spec

- New first child of the menu container, before `items.map(...)`:
  - row: `flex items-center gap-2 border-b border-border px-3 py-2`
  - the orbital SVG from the sidebar, scaled down (`className="size-4"`), same three elements:
    circle r=6, ellipse rx=12 ry=4.5 rotated −18°, satellite dot at (26.5, 11.5)
  - text: `font-mono text-[10px] font-bold tracking-[0.2em] text-foreground`, composed as
    `PFT <span className="text-muted-foreground">{'//'}</span> <span className="text-gradient">TERMINAL</span>`
- **Give the gradient a unique id.** The sidebar already uses `id="pft-orbit"`. A second SVG with the
  same id makes both marks reference whichever gradient the browser resolved first. Use
  `id="pft-menu-orbit"` here.
- The header is decorative: `role="presentation"` and `aria-hidden="true"`. It must not become a
  menu item.

### What must not break

- `itemElements` is filled by array index during the item map (line ~404), not by querying the DOM,
  so a header div does not shift it — but verify arrow-key navigation still lands on the first
  *item*, not the header, and that Enter on a focused item still fires it.
- The menu is positioned by measuring itself after render (`measure()` in the open effect). The extra
  row changes the height; confirm the menu still clamps inside the chart on all four edges, including
  when opened near the bottom-right corner.
- The double right-click escape hatch (second right-click within the window must reach the native
  browser menu) must still work.
- `rounded-lg overflow-hidden` on the container must stay, and the header must not visually overflow
  the rounded corners.

### Acceptance

Screenshot of the menu open with the header visible, plus one screenshot of the menu opened near the
bottom-right of the chart to show it is still clamped.

---

## Part 3 — Align the text in the alert dialog

`components/terminal/PriceAlertDialog.tsx`, the form body.

The dialog currently mixes alignments. Make one left edge for everything and give the price block
room to breathe.

### Checklist

1. **Price input text left-aligned.** `type="number"` centres its value in some browsers/locales. Add
   an explicit `text-left` (keep `tabular-nums`, keep `px-2`). The value must start at the same x as
   `EURUSD` in the Symbol field above it.
2. **Hint under the price does not touch the field.** `Example: 1.12140 · 5 decimal places` currently
   crowds the input's bottom border. Give it `mt-0.5 leading-snug` and keep the block's `gap-2`.
   Left edge identical to the input's text.
3. **Every label shares one left edge.** `Symbol`, `Price`, `Direction`, the "We will email you at …"
   line and the "Active alerts for …" box must all start at the form's padding. Nothing in the body
   may be centred — only the two footer buttons keep their current positions (Cancel left, Create
   right).
4. **Subtitle wraps cleanly.** `We will email you when EURUSD crosses the price you set.` must not be
   clipped at `max-w-sm`; allow two lines with normal line-height.
5. Do not change copy, colours, sizes or the `Create alert` / `Cancel` behaviour. This is alignment
   only.

### Acceptance

Before/after screenshots of the whole dialog at 100% zoom, plus a zoomed crop of the Price block
showing label, input and hint sharing one left edge.

---

## Part 4 — Verification before you report back

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx eslint components/terminal lib/stores` — 0 errors (warnings about `react-hooks/refs` in
      `ChartContextMenu` are pre-existing; do not add new ones)
- [ ] `npm run build` — green
- [ ] Manual pass with the dialog and the menu: open menu → copy level → notify me → select Below →
      create → the alert appears with `Below` → cancel it → it disappears
- [ ] No new console errors or warnings in the browser while doing the above
- [ ] No new network requests per render (watch the Network panel)

Report back with: files changed, a one-line explanation per item, the screenshots, and the SQL
result from Part 1 acceptance step 4.

---

## Part 5 — Out of scope

Do not touch, even if it looks wrong:

- Alert evaluation, email delivery, the `PriceAlert` schema, `lib/alerts/*`
- `vercel.json`, `workers/*`, any cron or migration
- The chart itself, drawings, the settings surface
- Anything under `app/api/**`
- Mobile layout — there is no mobile app yet

If one of those blocks a fix above, stop and say so instead of widening the change.
