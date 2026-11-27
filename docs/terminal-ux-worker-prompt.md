# Промпт для воркера: UX-правки терміналу (14 правок)

> Один послідовний промпт. Виконуй пакети **в порядку §3**, коміт на кожен пакет.
> Нічого не додавай «від себе»: якщо чогось немає в цьому документі — це поза
> скоупом. Наприкінці — звіт за шаблоном §16.

---

## §0. Контекст

Репозиторій: `C:/Users/User/Documents/Типовий проєкт` (Next.js 16 App Router,
React 19, TypeScript, Tailwind v4, Prisma 6 + Postgres, Capacitor WebView APK).

Задача — серія UX-правок у трейдерському терміналі (`/dashboard/terminal`) і
навколо нього: щільність і акценти верхньої панелі, пріоритет параметрів
ордера, налаштування типів ордерів, поведінка чарта, центр сповіщень, пам'ять
вибраного акаунта, білінг і монітор правил.

**Це не редизайн.** Кожна правка точкова: змінюємо пріоритет, розташування,
колір акценту або поведінку — не переписуємо сторінки.

### Дизайн-система (не вигадуй свою)

- Токени Tailwind: `bg-background`, `bg-card`, `bg-sidebar`, `bg-secondary`,
  `border-border`, `text-foreground`, `text-muted-foreground`, `text-primary`,
  `text-danger`, `text-warning`, `text-highlight`, `ring-ring`.
- Грошові CTA — `emerald-500` / `emerald-950` (див. «Pay now» у білінгу).
- Іконки — `lucide-react`. Утиліта класів — `cn()` з `@/lib/utils`.
- Компоненти UI — `components/ui/*` (`button`, `tabs`, `dialog`, `dropdown-menu`,
  `sheet`, `table`). Не додавай нових UI-бібліотек.
- Числа завжди `font-mono tabular-nums`.

### Що вже є в коді (щоб не шукати)

| Що | Де |
|---|---|
| Верхня панель терміналу | `components/terminal/TerminalHeader.tsx` |
| Картка ордера | `components/terminal/OrderPanel.tsx` |
| Чарт (рівні, drag, preview) | `components/terminal/TradingChart.tsx` |
| Таблиця позицій + Rules monitor | `components/terminal/PositionsTable.tsx` |
| Банки/банери + вибір акаунта | `components/terminal/TerminalWorkspace.tsx` |
| Стан книги рахунку | `lib/stores/useTerminalBook.ts` |
| Стан картки ордера | `lib/stores/useOrderTicketStore.ts` |
| Бокова навігація | `components/dashboard/sidebar.tsx` |
| Білінг | `components/dashboard/billing-view.tsx`, `lib/stores/useBilling.ts` |
| Налаштування | `components/settings/settings-view.tsx`, `lib/settings/preferences.ts` |
| Правила reset | `lib/accounts/reset.ts` (§18.2 рулбука) |
| Email-інфраструктура | `lib/email/*` (`sendEmail`, `pftEmailShell`) |
| Rate limit | `lib/trader/rate-limit.ts` (`isRateLimited`) |
| Trading cron | `app/api/cron/trading/route.ts` |

---

## §0.1. Припущення, які я прийняв замість уточнення

Прочитай перед стартом. Якщо якесь припущення суперечить скріншоту — скажи про
це в звіті, але **не змінюй** реалізацію на свій розсуд.

| # | Припущення | Підстава |
|---|---|---|
| 1 | Коли Stop/Stop-Limit вимкнені, друга вкладка називається **`Limit`** і замінює `Pending` (а не просто ховає дві кнопки) | стрілка на скріншоті йде від чипа `LIMIT` **вгору** до вкладки `Pending` |
| 2 | Кнопка центру сповіщень — emerald-акцент із шевроном, що обертається на 180° | «салатовий колір» = той самий `emerald-500`, що `Pay now` і `Return to payment` |
| 3 | «Надіслати собі на пошту» = дайджест вибраних повідомлень, КД 3/год + 1/хв | щоб кнопка не стала спам-каналом |
| 4 | `Appeal decision` прибираємо з банера, але лишаємо посилання `Contact support` | «не має бути під рукою» ≠ «скасувати право на апеляцію» |
| 5 | Reset-правила §18.2 **уже реалізовані**; пакет 12 — аудит і точкові правки, не переписування | `lib/accounts/reset.ts` покриває знижку 20%/2 доби, ліміт 30 діб, frozen, abuse-патерни |
| 6 | «Мигаюча паличка» = ознака редагованості (I-beam + каретка), а не заборона виділяти текст | трейдеру треба копіювати ціни й номери ордерів |
| 7 | Rules monitor = півколо-«годинник» з відсотком у центрі | «перенеси всю інфу на годинники» |
| 8 | Поріг попередження — 80%, один лист на правило на добу | узгоджено з кольорами DD (warning ≥50%, danger ≥80%) |

---

## §1. Жорсткі правила

1. **Один пакет = один коміт.** Повідомлення: `pkg N: <що зроблено>`.
2. **Не чіпай** `android/`, `support-app/`, `.gitignore`, `CLAUDE.md`,
   `lib/ai/**`, `components/support/**`, `app/api/support/**` — там чужі зміни
   або інша задача.
3. **Без нових npm-залежностей.** Графіки/дуги — руками через SVG.
4. **Міграції БД дозволені, але лише адитивні**: новий файл у `prisma/sql/`
   з `ADD COLUMN IF NOT EXISTS` + запис у `ALLOWED_SQL_FILES` у
   `scripts/bootstrap-production.cjs` + відповідне поле в `prisma/schema.prisma`.
   Жодних `DROP`, `ALTER TYPE`, перейменувань.
5. **Не ламай існуючу логіку.** Якщо правка вимагає змінити поведінку, яку хтось
   свідомо зробив (наприклад, банер breach показується лише для вибраного
   акаунта) — зберігай її.
6. **Не вигадуй цифри й тексти.** Усі пороги, копірайт і кольори — з цього
   документа.
7. **Кожен пакет завершується зеленими** `npx tsc --noEmit` і `npm run lint`
   (без нових попереджень; базовий рівень — 81 warning).
8. **Не роби «покращень» поза списком.** Побачив інший баг — запиши в звіт
   (§16), не виправляй.
9. Якщо правка неможлива без ризику для грошей/ризик-логіки — **не роби**,
   поясни в звіті чому.

---

## §2. Карта правок користувача → пакети

| # користувача | Суть | Пакет |
|---|---|---|
| 2 | Верхня панель: акценти, сортування, вільне місце | 1 |
| 6 | SL/TP виділити поміж сірих цифр | 2 |
| 9 | У зоні TP/SL рахувати прибуток/збиток | 2 |
| 1 | Stop/Stop-Limit вимкнені за замовчуванням + перемикач у налаштуваннях акаунта | 3 |
| 7 | Підказка `drag` → Preview TP/SL на чарті (Market) | 4 |
| 8 | Sell Limit на чарті — червоний | 4 |
| 10 | Preview SL/TP для **вибраної** позиції, не останньої відкритої | 5 |
| 5 | «Мигаюча паличка» на некликабельному тексті | 6 |
| 4 | Виділити Live Terminal у навігації | 7 |
| 3 | Центр сповіщень замість банерів | 8 |
| 11 | Пам'ять вибраного акаунта (навіть після re-login) | 9 |
| 12 | Банер breach: людська назва акаунта, без Appeal, перенос банера оплати | 9 |
| 14 | Billing: Pay now → існуючий запит, скасування ордера, анімації | 10 |
| 12 (кінець) | Rules monitor → «годинники» | 11 |
| 13 | Email при наближенні до порушення правила | 11 |
| 12 (reset) | Аудит відповідності Reset правилам §18.2 | 12 |

---

## §3. Пакет 1 — верхня панель: акценти й порядок

**Файл:** `components/terminal/TerminalHeader.tsx`.

### 3.1. Проблема

Зараз `dl` з `grid-cols-3 sm:grid-cols-5` робить **усі** показники однаковими:
`Status`, `Balance`, `Equity`, `Margin`, `Free margin` — один розмір
(`text-[13px]`), один колір (`text-foreground`). Єдиний акцент — колір equity.
При цьому праворуч після `Free margin` лишається велике порожнє місце, а
`Daily DD buffer` — тонка смужка під всім.

### 3.2. Цільова структура

Три смислові зони замість п'яти рівних колонок:

**Зона A — «Скільки в мене грошей» (hero).**
- `Equity` — найбільше число в панелі: `text-2xl font-semibold tabular-nums`,
  колір `text-primary` при `floatingPnl >= 0`, інакше `text-danger`.
- Під ним у два стовпчики, дрібним (`text-[11px]`, `text-muted-foreground`):
  `Balance` і `Free margin` зі своїми значеннями.

**Зона B — «Скільки зайнято».**
- `Margin` як звичайний показник (`text-sm`), приглушений
  (`text-muted-foreground` для підпису, `text-foreground` для числа).
- `Status` — **не** показник, а чип поруч із символом (див. 3.3).

**Зона C — «Скільки лишилось до порушення» (ризик).**
- `Daily DD buffer`: сума, `% used` і смуга-метр в одному блоці.
- `% used = Math.round(ddRatio * 100)`. Колір: `< 50` → `text-primary`,
  `50–79` → `text-warning`, `>= 80` → `text-danger`. Смуга — тими самими
  кольорами, ширина `Math.max(4, (1 - ddRatio) * 100)%` (як зараз).
- Підпис зверху: `DAILY DD BUFFER`, значення праворуч — сума, і поруч
  маленьким `· 12% used`.

### 3.3. Розкладка

```
┌─ рядок 1 ───────────────────────────────────────────────────────────────┐
│ [Symbol ▾]  BID 1.09650  ASK 1.09658  SPREAD 0.8 pips  24H −0.04%       │
│ ● ACTIVE   [● LIVE · INDICATIVE SPREAD]                    [🕐 12:33]   │
├─ рядок 2 ───────────────────────────────────────────────────────────────┤
│ EQUITY            │ MARGIN      │ DAILY DD BUFFER  $286.18 · 12% used   │
│ $9,539.26         │ $0.00       │ ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│ BALANCE $9,539.26 │             │                                       │
│ FREE MARGIN $…    │             │                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

- `Status` переноситься в рядок 1 як чип: крапка + `ACTIVE` (або інший статус),
  `rounded-md border px-2 py-1 text-[10px] uppercase tracking-wider`.
  `ACTIVE` → `border-primary/30 bg-primary/10 text-primary`,
  інакше → `border-danger/30 bg-danger/10 text-danger`. Анімацію `animate-ping`
  з поточного `Metric` перенеси в цей чип (`motion-reduce:animate-none`).
- Рядок 2: `flex flex-wrap items-stretch gap-x-6 gap-y-3`, зони розділені
  `border-l border-border pl-6` (перша — без бордера). Додай `flex-1` до зони C,
  щоб вона забирала вільне місце.
- На `< xl` зони переносяться (`flex-wrap`), на `sm` і менше — вертикально.

### 3.4. Компонент

Замість `Metric` зроби один компонент з рівнем акценту:

```tsx
function Stat({ label, value, tone = 'normal', size = 'sm' }: {
  label: string
  value: string
  tone?: 'normal' | 'primary' | 'danger' | 'muted' | 'warning'
  size?: 'sm' | 'hero'
}) { … }
```

`size="hero"` → `text-2xl font-semibold`, `size="sm"` → `text-[13px]`.
`tone="muted"` → значення `text-muted-foreground`.

### 3.5. Приймання пакета 1

- `npx tsc --noEmit`, `npm run lint` — чисто.
- На 1280px і 1440px у рядку 2 немає горизонтального скролу й немає «пустої
  правої половини»: зона C розтягнута.
- `Equity` візуально найбільше число; при від’ємному floating P&L — `text-danger`.
- `Daily DD buffer` показує `% used` і змінює колір на `warning` при ≥50% і
  `danger` при ≥80%.
- `role="meter"` з `aria-valuenow/min/max` збережено.
- Рядок 1 при вузькому екрані переноситься без обрізання символу.

**Не роби:** не змінюй `SymbolPicker`, `TimezoneClock`, логіку `feedLabel`,
не додавай нових показників.

---

## §4. Пакет 2 — SL/TP: акцент і гроші

**Файли:** `components/terminal/OrderPanel.tsx`,
`components/terminal/PositionsTable.tsx`, новий `lib/terminal/level-tone.ts`.

### 4.1. Спільна палітра рівнів

Створи `lib/terminal/level-tone.ts` — єдине джерело кольорів SL/TP/ордерів:

```ts
/** Shared level palette. The chart already paints these; UI text must match. */
export const LEVEL_HEX = {
  sl: '#fb923c',
  tp: '#22c55e',
  limitBuy: '#3b82f6',
  limitSell: '#f43f5e',
  stop: '#f59e0b',
} as const

/** Tailwind classes for text/border, paired with the hex above. */
export const LEVEL_CLASS = {
  sl: { text: 'text-orange-300', border: 'border-orange-500/40', bg: 'bg-orange-500/10' },
  tp: { text: 'text-emerald-300', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10' },
} as const
```

`TradingChart.tsx` має імпортувати `LEVEL_HEX` замість локальних
`STOP_LOSS_COLOR` / `TAKE_PROFIT_COLOR` (значення ті самі — колір не зміниться).

### 4.2. Блок SL/TP у картці ордера

Було: два звичайні `Field` у `grid grid-cols-2`, підпис сірий, значення
прибутку/збитку — `text-[11px]`.

Стало: блок `ProtectionBlock`:

- Кожне поле — з кольоровим лівим бордером (`border-l-2` + `LEVEL_CLASS`),
  підпис `STOP LOSS` / `TAKE PROFIT` кольором рівня (`text-[10px] uppercase`),
  інпут як зараз.
- Під інпутом — **великий** рядок результату: `text-[13px] font-semibold`,
  зі знаком: `Risk −$18.30` / `Reward +$5.70`. Якщо поле порожнє — нічого.
- Під парою — рядок підсумку (`text-[10px] text-muted-foreground font-mono`):
  `R:R 1 : 2.40 · risk 0.19% of equity`.
  - `R:R` = `|tp − entry| / |entry − sl|`, округлення до 2 знаків; показуй лише
    коли задані обидва рівні й знаменник > 0.
  - `risk %` = `|projections.sl| / equity * 100`, equity з
    `useTerminalBook((s) => s.snapshot.equity)`; показуй лише коли equity > 0.
- Якщо обидва поля порожні — замість рядка підсумку підказка:
  `Add SL/TP to see risk and reward.`

`entry` для проєкцій у Market-режимі — як зараз (`ask` для BUY, `bid` для SELL).
У Pending — ціна виконання (`pendingType === 'STOP' ? stop : limit`), щоб
проєкція не брехала.

### 4.3. SL/TP у таблиці позицій

`PositionsTable.tsx`, колонки `SL` і `TP`: значення отримують
`LEVEL_CLASS.sl.text` / `LEVEL_CLASS.tp.text`, `font-medium`; `—` лишається
`text-muted-foreground`. Додай `title` з повним значенням і `aria-label`
(`Stop loss 1.09316`).

Заголовки колонок `SL` / `TP` — теж кольором рівня, щоб око чіплялось.

### 4.4. Приймання пакета 2

- Ввів SL і TP → одразу видно `Risk −$…` і `Reward +$…`, плюс `R:R`.
- Для BUY і SELL знаки правильні (SL завжди збиток, TP завжди прибуток).
- Порожні поля → підказка, без `NaN`, без `Infinity`.
- У таблиці SL/TP не сірі; решта колонок без змін.
- Кольори в чарті не змінились (`git diff` показує лише заміну констант на
  імпорт).

---

## §5. Пакет 3 — Stop/Stop-Limit: вимкнено за замовчуванням + налаштування акаунта

**Файли:** `prisma/schema.prisma`, `prisma/sql/order-ticket-settings.sql`,
`scripts/bootstrap-production.cjs`, `lib/settings/preferences.ts`,
`app/api/settings/preferences/route.ts`, `components/settings/*`,
`lib/stores/useOrderTicketStore.ts`, `components/terminal/OrderPanel.tsx`.

### 5.1. Дані

`schema.prisma`, модель `User`, поряд з іншими preferences:

```prisma
  /** Show STOP / STOP-LIMIT in the order ticket. Off by default: limit orders only. */
  advancedOrderTypes Boolean @default(false)
```

`prisma/sql/order-ticket-settings.sql`:

```sql
-- Advanced order types toggle (Settings → Trading). Idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "advancedOrderTypes" BOOLEAN NOT NULL DEFAULT false;
```

Додай `'order-ticket-settings.sql'` в `ALLOWED_SQL_FILES`
(`scripts/bootstrap-production.cjs`) — без цього bootstrap впаде на валідації
allowlist.

### 5.2. Preferences API

`lib/settings/preferences.ts`:
- тип `Preferences` + `PreferenceInput`: `advancedOrderTypes: boolean`;
- `PREFERENCE_SELECT`: `advancedOrderTypes: true`;
- `normalizePreferences`: `row.advancedOrderTypes === true` (не `??`, щоб `null`
  не став true);
- `validatePreferences`: приймай лише `typeof === 'boolean'`, інакше
  `{ ok: false, error: 'advancedOrderTypes must be a boolean.' }`;
- `DEFAULT_PREFERENCES` — `false`.

`app/api/settings/preferences/route.ts`: передай поле у `validatePreferences` і
в `recordActivity` metadata (воно туди потрапляє автоматично з `result.data`).

### 5.3. UI налаштувань — саме налаштування акаунта

`components/settings/settings-view.tsx`: додай **четверту** секцію

```ts
{ id: 'trading', label: 'Trading', shortLabel: 'Trading', icon: CandlestickChart, description: 'Order ticket and order types' }
```

і панель `components/settings/trading-panel.tsx`:

- заголовок `Order ticket`;
- перемикач (switch) з підписом **Stop & Stop-Limit orders** і описом
  `Show STOP and STOP-LIMIT in the Pending tab. Limit orders stay available either way.`
- стан зберігається через `PATCH /api/settings/preferences` (той самий шлях, що
  й інші preferences), з індикатором збереження як у `PreferencesPanel`.
- під перемикачем — дрібна примітка: `Applies to your account, not to this
  browser. Existing working orders are not affected.`

**Важливо:** це не `ChartSettingsSurface` (там налаштування чарта). Користувач
явно просив «не чарту, а акаунта».

### 5.4. Стан у терміналі

Додай у `lib/stores/useOrderTicketStore.ts`:

```ts
advancedOrderTypes: boolean
setAdvancedOrderTypes: (value: boolean) => void
```

Значення гідратується з `/api/settings` (у `TerminalWorkspace` вже є `loadTrader`;
додай окремий `useEffect` з `fetch('/api/settings')`, поле
`preferences.advancedOrderTypes`). Для миттєвого першого рендера дублюй у
`localStorage` під ключем `pft:advancedOrderTypes` — читай при ініціалізації,
перезаписуй після завантаження з сервера.

`resetForSymbol` не має скидати цей прапорець.

### 5.5. Картка ордера

`OrderPanel.tsx`. Користувач показав стрілкою, що `LIMIT` має **піднятися на
місце вкладки `Pending`** — тобто коли розширені типи вимкнені, друга вкладка
називається `Limit`, а не `Pending`, і всередині немає ряду з трьох кнопок.

`advancedOrderTypes === false`:
- `TabsList` — `Market | Limit` (замість `Market | Pending`);
- вкладка `limit` містить **тільки** поле `Limit price` + підказку
  `Fills when the market reaches your limit price.` — без ряду
  `LIMIT / STOP / STOP-LIMIT`;
- `pendingType` примусово `'LIMIT'`.

`advancedOrderTypes === true`:
- `TabsList` — `Market | Pending`, як зараз;
- всередині ряд `grid-cols-3` з `LIMIT`, `STOP`, `STOP-LIMIT` і відповідні поля.

Додатково:
- `useEffect` на зміну прапорця: якщо вимкнено і `pendingType !== 'LIMIT'` →
  `setPendingType('LIMIT')`.
- `execute()` перевіряє: якщо `!advancedOrderTypes && pendingType !== 'LIMIT'` —
  не відправляти (захист від гонки між перемиканням і кліком).
- `chooseOrderTab` не змінюй — він уже відкриває pending з `pendingType`.

### 5.6. Приймання пакета 3

- Новий користувач: друга вкладка називається `Limit`, усередині лише
  `Limit price`.
- Перемикач у `Settings → Trading` вмикає вкладку `Pending` з трьома кнопками;
  після reload і після re-login стан зберігається.
- Вимкнення прапорця при активному `STOP` у картці скидає на `LIMIT`.
- Існуючі `STOP`/`STOP_LIMIT` ордери в таблиці й на чарті **не зникають**.
- `npx tsc --noEmit`, `npm run lint` чисто; `prisma generate` проходить.

---

## §6. Пакет 4 — чарт: підказка `drag` і колір Sell

**Файли:** `components/terminal/TradingChart.tsx`,
`components/terminal/OrderPanel.tsx`, `lib/stores/useOrderTicketStore.ts`.

### 6.1. Колір Pending за стороною

Зараз `PENDING_LIMIT_COLOR = '#3b82f6'` для будь-якої сторони — тому `SELL
LIMIT` намальований синім.

Правило: лінія ліміту бере колір сторони — `BUY` → `LEVEL_HEX.limitBuy`
(синій), `SELL` → `LEVEL_HEX.limitSell` (червоний `#f43f5e`). Лінія тригера
`STOP` лишається `LEVEL_HEX.stop` (амбер), бо це інша сутність.

Місця: `buildChartLevels` (обидва `LIMIT` і `STOP-LIMIT · limit`) і
`buildDraftLevels` (`draft:limit`).

Підпис бейджа не змінюй (`SELL LIMIT · preview`).

### 6.2. Preview SL/TP для Market-ордера

Зараз `buildDraftLevels` повертає `[]`, якщо `orderType !== 'pending'` — тому в
Market-вкладці SL/TP на чарті не видно взагалі.

Зміни:

- Дозволь draft-рівні для `orderType === 'market'`, якщо `draftSymbol === symbol`
  і відповідне поле задане. `draftEntry` = `side === 'BUY' ? ask : bid`
  (передай у функцію `entry`).
- `draftField` = `'stopLoss'` / `'takeProfit'` — щоб перетягування писало назад
  у картку (механізм уже є).

### 6.3. Підказка `drag`

У `ProtectionBlock` (пакет 2) під кожним полем додай маленьку кнопку-підказку:

```
[↕ drag]
```

- `type="button"`, `text-[10px] uppercase tracking-wide`,
  `text-muted-foreground hover:text-foreground`, іконка `MoveVertical` 12px.
- `aria-label`: `Show stop loss preview on the chart` /
  `Show take profit preview on the chart`.
- Клік:
  1. якщо поле порожнє — підставіть дефолт із `defaultPendingPrices(...)`
     (SL — `stopLoss`, TP — `takeProfit`), щоб лінія одразу з'явилась;
  2. виклич `setField` із цим значенням;
  3. покажи на чарті нетривалий хінт `Drag the line on the chart to adjust`
     (той самий механізм `notice`, що вже є в картці, tone `info`).

Кнопки дві — окремо під SL і під TP: «дивлячись де саме людина нажала».

### 6.4. Приймання пакета 4

- `SELL LIMIT` на чарті — червоний; `BUY LIMIT` — синій; тригер `STOP` — амбер.
- Market-вкладка: ввів SL → на чарті з’являється пунктирна лінія нижче ціни;
  ввів TP → вище. Перетягування оновлює значення в інпуті.
- Клік `drag` при порожньому полі заповнює поле і малює лінію.
- Хінт не перекриває кнопку `Execute trade`, зникає сам (як існуючі notice).

---

## §7. Пакет 5 — Preview SL/TP для вибраної позиції

**Файли:** `lib/stores/useTerminalBook.ts` (або новий маленький стор),
`components/terminal/PositionsTable.tsx`, `components/terminal/TradingChart.tsx`.

### 7.1. Причина бага

`TradingChart.tsx`:

```ts
function activePositionFor(positions: Position[], symbol: string) {
  // бере ПОЗИЦІЮ З НАЙПІЗНІШИМ openedAt
}
```

Тому при 2+ позиціях `Preview SL/TP` і перетягування завжди працюють з
останньою відкритою, а не з тією, яку трейдер вибрав.

### 7.2. Виправлення

1. У `useTerminalBook` додай `selectedPositionId: string | null` і
   `selectPosition: (id: string | null) => void`. Скидай у `null` при `init`
   (новий акаунт) і коли позиції з таким id більше немає (`sync`).
2. `PositionsTable`:
   - клік по рядку позиції → `selectPosition(position.id)`;
   - клік по олівцю → `selectPosition(position.id)` **і** `startEdit(...)`;
   - вибраний рядок: `bg-primary/5` + `border-l-2 border-primary` (через
     `className` на `TableRow`), `aria-selected`;
   - рядки Pending не вибираються (вони не мають SL/TP-редагування).
3. `TradingChart`:
   - `activePositionFor(positions, symbol, selectedPositionId)` — спершу
     шукає `selectedPositionId` серед позицій цього символу, і лише якщо його
     немає — падає на «найпізніша відкрита» (щоб поведінка без вибору не
     змінилась);
   - перетягування рівня комітить у `level.position.id` (уже так) — перевір, що
     після зміни вибору `commitLevel` не бере старий рівень із замикання.

### 7.3. Приймання пакета 5

- Дві відкриті позиції по одному символу. Вибираю **першу**, тисну олівець →
  на чарті показуються й редагуються SL/TP **першої**; друга не змінюється.
- Після закриття вибраної позиції вибір скидається, чарт показує наступну.
- Без жодного вибору поводиться як раніше (остання відкрита).
- `npm run test:ai-grounding` не падає (перевірка, що нічого не зачеплено).

---

## §8. Пакет 6 — «мигаюча паличка» на некликабельному тексті

**Файли:** `app/globals.css`, `components/terminal/TerminalWorkspace.tsx`.

### 8.1. Що саме бачить користувач

Клік по `EQUITY $3,000.00`, по ціні, по комірці таблиці — з’являється
вертикальна риска й курсор-«I-beam», ніби там можна писати.

Причина в коді **не підтверджена** (у проєкті немає жодного `contentEditable`,
`user-select` чи `caret-color`). Тому виправляй гіпотези по порядку й запиши в
звіті, яка спрацювала:

1. `cursor: text` / `cursor: auto` на текстових елементах → браузер показує
   I-beam над будь-яким текстом.
2. Текст виділяється подвійним кліком і лишає «каретку» візуально.
3. У WebView (APK) довге натискання входить у режим виділення.

### 8.2. Правка

1. У `TerminalWorkspace` на кореневий `div` додай `data-terminal-root`.
2. У `app/globals.css` додай (поза `@layer`, щоб мало достатню специфічність):

```css
/* Static terminal text must not look editable: no I-beam, no caret. */
[data-terminal-root] :where(dl, dt, dd, p, span, h1, h2, h3, h4, table, th, td, li) {
  cursor: default;
}
[data-terminal-root] :where(dl, dt, dd, table, th, td) {
  caret-color: transparent;
}
[data-terminal-root] :where(input, textarea, select, [contenteditable='true']) {
  cursor: auto;
  caret-color: auto;
}
```

3. **Не став** `user-select: none` на таблиці й метрики: трейдер має мати
   можливість скопіювати ціну чи номер ордера. Мета — прибрати **ознаку
   редагування**, не копіювання.
4. Перевір, що жоден елемент не отримав `tabIndex` без причини: клік не має
   ставити фокус на `div`.

### 8.3. Приймання пакета 6

- Клік по `EQUITY`, по `BID`, по комірці `SL` → каретки немає, курсор звичайний.
- Клік по інпуту картки ордера → каретка є, введення працює.
- Текст досі виділяється мишею і копіюється.
- У звіті — яка з трьох гіпотез підтвердилась.

---

## §9. Пакет 7 — виділити Live Terminal у навігації

**Файл:** `components/dashboard/sidebar.tsx`.

Зараз активний пункт — `bg-primary/10` + тонка смужка зліва. Користувач хоче,
щоб `Live Terminal` читався з першого погляду серед решти пунктів.

Для `view === 'terminal'` (перший пункт `TERMINAL_NAV`):

- фон: `bg-linear-to-r from-primary/20 via-primary/10 to-transparent`;
- рамка: `border border-primary/30`, `rounded-lg`;
- текст: `text-foreground font-semibold`, іконка `text-primary`;
- іконка в квадраті: `grid size-7 place-items-center rounded-md bg-primary/15
  border border-primary/25`;
- свічення: `shadow-[0_0_24px_-14px] shadow-primary`;
- праворуч — чип `LIVE`: `ml-auto rounded-full border border-primary/40
  bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest
  text-primary` з пульсуючою крапкою (як `BRIDGE CONNECTED`), `motion-reduce` →
  без анімації;
- смужку зліва (`absolute inset-y-1.5 left-0 w-0.5`) прибери для цього пункту,
  вона дублює рамку.

Інші пункти — без змін. `aria-current="page"` зберегти.

**Приймання:** пункт помітно виділяється; при переході на іншу сторінку
виділення переходить на неї, `Live Terminal` повертається до звичайного стану;
фокус-рінг з клавіатури працює.

---

## §10. Пакет 8 — центр сповіщень

**Найбільший пакет.** Нові файли + зміни в `TerminalWorkspace`.

### 10.1. Проблема

Зараз кожне повідомлення — окремий банер на всю ширину над чартом:
`NoticeBar` (події книги), банер «New challenge is processing», банер
«Account … is ready», плюс локальний `notice` у картці ордера. Вони з’їдають
висоту чарта, не мають історії, їх не можна відсортувати й не можна повернутись
до ордера, про який ідеться.

### 10.2. Модель

`lib/stores/useNotifications.ts` (новий, zustand + `localStorage`):

```ts
export type NotificationKind = 'order' | 'account' | 'payment' | 'rule' | 'system'

export type NotificationItem = {
  /** Deterministic, so a repeated event cannot create a duplicate row. */
  id: string
  kind: NotificationKind
  tone: 'success' | 'danger' | 'info' | 'warning'
  title: string
  message: string
  createdAt: number
  read: boolean
  /** Deep link target inside the terminal. */
  ref?: { kind: 'position' | 'pending'; id: string }
}
```

Store API:

```ts
items: NotificationItem[]
push: (item: Omit<NotificationItem, 'id' | 'createdAt' | 'read'> & { id: string }) => void
markRead: (id: string) => void
markAllRead: () => void
remove: (id: string) => void
clear: () => void
hydrate: () => void
```

Правила:
- максимум **200** записів; при переповненні — видаляй найстаріші;
- `push` ігнорує `id`, що вже є (ідемпотентність);
- персист у `localStorage` під `pft:notifications:v1`, запис — у `push`,
  `markRead`, `clear`; `hydrate()` викликається в `TerminalWorkspace` на маунті;
- не зберігай нічого, крім цих полів (жодних токенів/цін акаунта).

### 10.3. Джерела

| Подія | kind | id | ref |
|---|---|---|---|
| `describeEvents` → `orderUpdates` (FILLED/REJECTED/CANCELLED) | `order` | `order:${status}:${message.slice(0,40)}:${minuteBucket}` | `{kind:'position', id: positionId}` якщо є |
| `describeEvents` → SL/TP hit (`closed`) | `order` | `close:${trade.id}` | `{kind:'position', id: trade.id}` |
| «Account X is ready» | `account` | `account-ready:${id}` | — |
| «New challenge is processing» | `payment` | `payment:${orderId}` | — |
| Новий акаунт з’явився в селекторі | `account` | `account-added:${id}` | — |

Щоб deep-link працював, розшир `BookEvents.orderUpdates` у
`lib/trading/types.ts`:

```ts
orderUpdates: {
  status: 'FILLED' | 'REJECTED' | 'CANCELLED'
  message: string
  symbol?: string
  positionId?: string
  pendingId?: string
}[]
```

і заповнюй `positionId`/`pendingId`/`symbol` у `lib/trading/engine.ts` там, де
подія створюється (рядки ~820, ~947, ~986 — шукай `w.orderUpdates.push`). Поля
опційні: старі виклики й тести не мають зламатись.

`describeEvents` (`lib/stores/useTerminalBook.ts`) прокидає `ref` у
`TerminalNotice`:

```ts
export type TerminalNotice = {
  tone: 'info' | 'success' | 'danger'
  message: string
  switchToAccountId?: string
  ref?: { kind: 'position' | 'pending'; id: string }
}
```

### 10.4. Що лишається банером

**Тільки** банер про статус акаунта (breached / trading disabled) — він
лишається на екрані й показується лише для вибраного акаунта. Це вже
реалізовано, не ламай.

Все інше — у центр сповіщень:
- `notice` зі стору → `push` + `dismissNotice()`;
- банер `pendingOrders` («New challenge is processing») → `push` при появі й
  оновленні;
- банер `activatedAccount` → `push` при появі;
- локальний `notice` у `OrderPanel` (успіх/помилка ордера) → `push` + лиши
  inline-рядок помилки для невдачі (помилку треба бачити біля кнопки).

### 10.5. Компонент

`components/terminal/NotificationCenter.tsx`:

**Згорнутий стан** — один рядок під `TerminalHeader`:
- кнопка-перемикач у кольорі акценту: `bg-emerald-500 text-emerald-950`,
  `h-7 rounded-md px-3`, hover `bg-emerald-400` — той самий стиль, що `Pay now`
  у білінгу (це і є «салатовий» акцент користувача);
- всередині: `Bell` 14px, текст `Notifications`, лічильник непрочитаних
  (`rounded-full bg-emerald-950/20 px-1.5 text-[10px]`), і `ChevronDown` 14px;
- шеврон обертається на 180° при відкритті:
  `className={cn('size-3.5 transition-transform duration-300', open && 'rotate-180')}`;
- праворуч від кнопки — останнє повідомлення одним рядком, обрізане
  (`truncate text-[11px] text-muted-foreground`).

**Розгорнутий стан** — панель під тим самим рядком (`border border-border
rounded-lg bg-card`):
- тулбар: фільтр `All / Orders / Account / Payments / Rules` (chips, як у
  `TabsList`), сортування `Newest / Oldest` (select), `Mark all read`,
  `Clear`;
- список: `max-h-80 overflow-y-auto divide-y divide-border`;
- рядок: кольорова крапка тону, `title` (напівжирний, 12px), `message`
  (11px, `text-muted-foreground`), відносний час (`2 min ago`), і дії:
  - `Open` — якщо є `ref`: `selectPosition(ref.id)`, скрол до
    `#positions-table`, підсвітка рядка `ring-2 ring-primary` на 2 с,
    `markRead`;
  - `Email` — див. 10.6;
  - `×` — `remove`.
- непрочитані: `bg-primary/5` + крапка `bg-primary`;
- порожній стан: `No notifications yet. Orders, payments and account events
  will appear here.`
- клавіатура: `Escape` закриває, перемикач має `aria-expanded`.

`PositionsTable` отримує `id="positions-table"` і бере `selectedPositionId` зі
стору, щоб підсвітка працювала й без скролу.

### 10.6. Надіслати собі на пошту (з КД)

`POST /api/notifications/email` (новий):

- body `{ ids: string[] }` (1–20 id);
- `requireTrader()`;
- **КД:** `isRateLimited(\`notify-email:${session.sub}\`, 3, 60 * 60_000)` →
  не більше 3 листів на годину; додатково `isRateLimited(\`notify-email-min:${session.sub}\`, 1, 60_000)`
  → не частіше одного на хвилину. При перевищенні — `429` з
  `{ error: 'Too many emails. Try again in a few minutes.', retryAfterMs }`.
- лист через `sendEmail` + `pftEmailShell` (тон `info`), заголовок
  `Your PFT notifications`, тіло — `emailRows` з кожного повідомлення
  (`[title, message]`), CTA `Open terminal` → `${appUrl()}/dashboard/terminal`.
- `idempotencyKey: \`notify-digest-${session.sub}-${ids.sort().join('-')}\`` —
  повторний клік по тих самих id не створить другий лист.
- клієнт: кнопка `Email` показує `Sending…`, після успіху — `Sent`, після 429 —
  таймер `Try again in 0:47` (рахунок із `retryAfterMs`).

### 10.7. Приймання пакета 8

- Банерів над чартом більше немає (крім breach).
- Відкрив ордер → з’явився запис `BUY 0.10 BTCUSD: market order filed…` з
  `Open`, який підсвічує саме цю позицію.
- Перезавантаження сторінки — історія на місці, лічильник непрочитаних
  збережений.
- Сортування `Oldest` перевертає список; фільтр `Payments` лишає тільки
  платежі.
- Шеврон обертається плавно (300 мс) в обидва боки.
- `Email` надсилає один лист; другий клік протягом хвилини — заблокований із
  видимим таймером.
- Breach-банер на місці й не дублюється в центрі сповіщень.
- `npx tsc --noEmit`, `npm run lint`, `npm run test:support-ui` — чисто.

---

## §11. Пакет 9 — пам'ять акаунта, людська назва, без Appeal

**Файли:** `prisma/schema.prisma`, `prisma/sql/active-account.sql`,
`scripts/bootstrap-production.cjs`, `app/api/auth/me/route.ts`,
`app/api/terminal/active-account/route.ts` (новий),
`components/terminal/TerminalWorkspace.tsx`, `lib/trading/types.ts`,
`lib/trading/engine.ts`.

### 11.1. Пам'ять вибраного акаунта

Зараз `switchAccount()` пише `?account=` у URL, а `loadTrader()` вибирає
`requested ?? перший ACTIVE ?? перший`. Варто перейти на іншу сторінку й
повернутись — параметра немає, вибирається перший ACTIVE. Після re-login —
те саме.

1. `schema.prisma`, `User`:

```prisma
  /** Last account opened in the terminal. Restored after navigation and re-login. */
  lastActiveAccountId String?
```

2. `prisma/sql/active-account.sql`:

```sql
-- Remember the last terminal account. Idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastActiveAccountId" TEXT;
```

Додай у `ALLOWED_SQL_FILES`.

3. Новий `POST /api/terminal/active-account`, body `{ accountId }`:
   - `requireTrader()`;
   - перевір, що акаунт належить `session.sub` (`prisma.tradingAccount.findFirst`
     з `where: { id, userId }`), інакше `404`;
   - `prisma.user.update({ where: { id: session.sub }, data: { lastActiveAccountId } })`;
   - `204`.

4. `app/api/auth/me/route.ts` — сесія не містить цього поля, тому додай окремий
   запит:

```ts
const user = await prisma.user.findUnique({
  where: { id: session.sub },
  select: { lastActiveAccountId: true },
})
return NextResponse.json({
  trader: session,
  accounts: await listTraderAccounts(session.sub),
  lastActiveAccountId: user?.lastActiveAccountId ?? null,
})
```

   Тип `TraderMe` у `TerminalWorkspace` розшир відповідно.

5. `TerminalWorkspace`:
   - `switchAccount(id)` → `POST /api/terminal/active-account` (не чекаючи
     результату, `void … .catch(() => null)`) + поточна логіка з URL і `init`;
   - `loadTrader()` пріоритет:
     `URL ?account` → `trader.lastActiveAccountId` (якщо такий акаунт є в
     списку) → перший `ACTIVE` → перший;
   - **не** перемикай акаунт, якщо `mode === 'refresh'` (уже реалізовано) —
     збережи.

### 11.2. Людська назва замість cuid

Зараз банер показує `Switch to cmvgppu1qO004tm5lef7l7n` — сирий id.

- `lib/trading/types.ts`, `AccountView`: додай `activeSiblingDisplayId: string | null`.
- `findActiveSibling` зараз повертає `string | null` і має **дві** реалізації
  (`lib/trading/repository.ts` ~860 для Prisma і ~1399 для in-memory) плюс
  оголошення в інтерфейсі `BookTx` (~190). Зміни всі три на
  `Promise<{ id: string; displayId: string } | null>`, додавши `displayId: true`
  у `select` і в мапер in-memory реалізації.
- `lib/trading/engine.ts` (~рядок 900): там, де рахується
  `activeSiblingAccountId: tradingAllowed(w) ? null : await w.tx.findActiveSibling()`,
  заміни на один виклик і заповнюй обидва поля:

```ts
const sibling = tradingAllowed(w) ? null : await w.tx.findActiveSibling()
// …
activeSiblingAccountId: sibling?.id ?? null,
activeSiblingDisplayId: sibling?.displayId ?? null,
```

  Перевір усі інші місця, де `activeSiblingAccountId` будується для відповіді
  (наприклад, `buildAccountView`), щоб поле не лишилось `undefined`.
- `TerminalWorkspace`, банер: `Switch to {account.activeSiblingDisplayId ?? 'standby account'}`,
  а `onClick` — на `activeSiblingAccountId`.

### 11.3. Прибрати `Appeal decision` з банера

- Видали кнопку `Appeal decision` і `appealOpen` з `NoticeBar`.
- `components/terminal/AppealDialog.tsx` **не видаляй** і API апеляцій не
  чіпай — просто прибери точку входу «під рукою».
- Замість неї в тому ж банері — посилання `Contact support` (звичайний
  `<a href="/dashboard/support">`, `text-xs underline`), щоб шлях не зник
  зовсім.
- У центрі сповіщень для події breach додай `message`, що апеляція доступна
  через підтримку (без кнопки).

### 11.4. Банер оплати → у центр сповіщень

Банер «New challenge is processing — the account will appear in the selector
automatically once the payment confirms.» з кнопкою `Return to payment`
**більше не рендериться на сторінці**. Він стає записом у центрі сповіщень
(kind `payment`), а кнопка `Return to payment` — дією цього запису
(`href` з `paymentUrl`, той самий emerald-стиль).

Breach-банер лишається як є (див. §10.4).

### 11.5. Приймання пакета 9

- Вибрав другий акаунт → перейшов у `Billing` → повернувся в термінал: той
  самий акаунт.
- Вийшов і зайшов знову — той самий акаунт.
- Відкрив пряме посилання з `?account=<id>` — перемагає URL.
- Банер breach показує `Switch to PFT-…` (людський id), не cuid.
- Кнопки `Appeal decision` немає; `Contact support` веде на підтримку.
- Банера «New challenge is processing» на сторінці немає, запис є в центрі
  сповіщень із робочою кнопкою оплати.

---

## §12. Пакет 10 — Billing: Pay now, скасування, анімації

**Файли:** `components/dashboard/billing-view.tsx`,
`lib/stores/useBilling.ts`, `lib/dashboard/billing.ts`,
`app/api/dashboard/billing/route.ts`, нові
`app/api/dashboard/billing/orders/[id]/cancel/route.ts` і
`app/api/dashboard/billing/orders/[id]/pay/route.ts`.

### 12.1. `Pay now` має вести на існуючий запит

Зараз це `<a href={order.paymentUrl}>`. Якщо інвойс прострочений або URL
відсутній, відкриття створює **новий** інвойс, і в таблиці з’являється новий
PENDING-рядок. Трейдер бачить «кнопка створює новий запит».

Правильно:

1. `BillingOrder` розшир: `planSize: number | null`, `evaluationLabel: string | null`,
   `drawdownMode: 'static' | 'trailing' | null`, `dailyLossType: number | null`,
   `hasFrozenBackup: boolean`. Заповни в `lib/dashboard/billing.ts` з
   `rawPayload` замовлення.
2. Новий `POST /api/dashboard/billing/orders/[id]/pay`:
   - `requireTrader()`; замовлення мусить належати трейдеру, інакше `404`;
   - якщо `status !== 'PENDING'` → `409`;
   - якщо `paymentUrl` є і не прострочений (`expiresAt` з `rawPayload`, якщо є)
     → `{ url: paymentUrl, reused: true }`;
   - інакше — резолв через наявний механізм intent-ів
     (`checkoutIntentKey`, `POST /api/checkout/status`), і лише якщо живого
     інвойсу немає — `POST /api/checkout` з тими самими розмірами
     (`resumed: true`), щоб **не** створити другий PENDING;
   - відповідь `{ url, reused: boolean }`.
3. Кнопка `Pay now` стає `button`, що викликає цей ендпоінт, показує
   `Opening…` і робить `window.location.assign(url)`.
   Ніяких нових `Order` для того самого продукту, поки існує PENDING.

### 12.2. Скасування активного ордера

1. `OrderStatus` уже містить `CANCELLED` — використай його, **не** додавай новий.
2. `POST /api/dashboard/billing/orders/[id]/cancel`:
   - `requireTrader()`, власник, `status === 'PENDING'` (інакше `409`);
   - `prisma.order.update({ data: { status: 'CANCELLED' } })`;
   - `recordActivity({ action: 'ORDER_CANCELLED', metadata: { orderId } })`;
   - `200 { status: 'CANCELLED' }`.
3. `BillingOrder['status']` — додай `'CANCELLED'`, `STATUS` map:
   `{ color: LABEL, label: 'Cancelled' }`.
4. UI: для PENDING-рядка поруч із `Pay now` — іконка `X` (`size-3.5`,
   `text-[#94A3B8] hover:text-[#EF4444]`), `aria-label="Cancel this payment
   request"`.
5. Клік → модальне вікно по центру в стилі сайту (як `InvoiceModal`:
   `fixed inset-0 bg-black/70`, картка `#0B0F19`, `rounded-xl`):
   - заголовок `Cancel this payment request?`;
   - текст: `Order ${orderId} will be closed. You can start a new checkout at
     any time — no money was taken.`;
   - кнопки: `Keep it` (ghost) / `Yes, cancel` (danger).
   - `Escape` і клік по фону закривають.
6. Після успіху — `load()` (перезавантажити список), рядок стає `Cancelled`.

### 12.3. Анімації

- `+` у `Pay now`: обертається **на −90°** при наведенні на кнопку й повертається
  назад:
  `className="… transition-transform duration-200 group-hover:-rotate-90"`,
  кнопка отримує `group`.
- `×` скасування: при наведенні **замінюється** на маленький сумний смайлик
  того ж розміру (`Frown` з lucide, `size-3.5`). Реалізуй через два елементи з
  `group-hover:hidden` / `hidden group-hover:block` — без JS-стану.
- Обидві анімації поважають `motion-reduce` (`motion-reduce:transition-none`,
  `motion-reduce:group-hover:rotate-0`).

### 12.4. Приймання пакета 10

- Клік `Pay now` на PENDING-рядку не додає новий рядок у таблицю.
- Скасування: рядок → `Cancelled`, `Pay now` зникає, гроші не списані.
- Модалка закривається `Escape`, фокус повертається на кнопку.
- `+` крутиться при hover і повертається; `×` перетворюється на смайлик.
- `npx tsc --noEmit`, `npm run lint` чисто.

---

## §13. Пакет 11 — Rules monitor як «годинники» + email при наближенні

### 13.1. Годинники

`components/terminal/PositionsTable.tsx`, `RuleCard` → `RuleGauge`:

- SVG 180°-дуга (півколо), радіус 54, `strokeWidth 10`, `strokeLinecap="round"`:
  - трек: `stroke="var(--secondary)"`;
  - значення: колір за `ratio` — `< 0.5` `var(--primary)`, `< 0.8`
    `var(--warning)`, інакше `var(--danger)`;
  - `strokeDasharray` = довжина дуги, `strokeDashoffset` = `len * (1 - ratio)`,
    `transition-[stroke-dashoffset] duration-500`;
- у центрі дуги: `{pct}%` (`text-2xl font-semibold tabular-nums`), під ним
  `used` (`text-[10px] uppercase tracking-widest text-muted-foreground`);
- під дугою: заголовок правила (як зараз), `used / limit`, caption;
- `ratio >= 0.9` → додай `animate-pulse` на крапку-індикатор (не на всю картку),
  `motion-reduce:animate-none`;
- семантика: `role="meter"` + `aria-valuenow/min/max` + `aria-label` з назвою
  правила;
- сітка лишається `md:grid-cols-2`.

«Чим більше заповнено — тим гірше»: колір росте до `danger`, і в caption
додай `· {buffer} left`.

### 13.2. Email при наближенні до порушення

Новий `lib/rules/proximity.ts`:

```ts
export const PROXIMITY_THRESHOLD = 0.8

/** Audit reason doubles as the dedupe key: one warning per rule per UTC day. */
export function proximityReason(rule: 'daily' | 'trailing', at: Date): string {
  return `RULE_PROXIMITY:${rule}:${at.toISOString().slice(0, 10)}`
}

export async function warnAccountsNearBreach(now = new Date()): Promise<number>
```

Логіка (за зразком `warnFundedAccountsBeforeNews` у `lib/market/news-windows.ts`):

- акаунти `status IN ('ACTIVE','FUNDED')`;
- для кожного — метрики з `syncAccount(account.id)` (уже імпортується в cron);
  рахуй `dailyUsedRatio` і `trailingUsedRatio`;
- якщо `ratio >= PROXIMITY_THRESHOLD` і для `proximityReason(rule, now)` немає
  `auditLog` з `action: 'RULE_PROXIMITY_WARNING'` → надішли лист і створи
  audit-запис з `metadata: { rule, ratio, used, limit, buffer }`;
- помилка листа не валить цикл (`console.warn` + `continue`);
- повертає кількість надісланих.

Новий `lib/email/rule-proximity.ts`:

- `sendRuleProximityWarning({ to, name, displayId, rule, used, limit, buffer, ratio })`;
- `pftEmailShell` з тоном `error` при `ratio >= 0.9`, інакше `pending`;
- `emailRows`: `Account`, `Rule`, `Used`, `Limit`, `Buffer left`, `Used %`;
- CTA `Open terminal` → `${appUrl()}/dashboard/terminal?account=${accountId}`;
- `idempotencyKey: \`rule-proximity-${displayId}-${rule}-${date}\``.

Виклик у `app/api/cron/trading/route.ts` поруч із
`warnFundedAccountsBeforeNews(...)`, у тому ж `try/catch`-стилі, що й сусіди.

### 13.3. Приймання пакета 11

- Rules monitor показує дві дуги; при 0% дуга майже порожня, при 80%+ — червона.
- Числа в центрі збігаються з `used / limit` під дугою.
- Юніт-тест `scripts/rule-proximity.test.ts` (додай у `test:unit` список
  відповідного скрипта): `proximityReason` стабільний у межах дня й різний для
  різних правил; `ratio < 0.8` не дає листа (замокай `sendEmail`).
- Ручний прогін: `curl -X GET localhost:3000/api/cron/trading` з
  `CRON_SECRET` — без помилок, `sent` у логах.

---

## §14. Пакет 12 — Reset account: аудит відповідності правилам

**Це пакет-звіт.** Код змінюй лише там, де є **підтверджена** розбіжність і
виправлення безпечне.

### 14.1. Що перевірити

Правила — рулбук §18.2 (у `lib/rules/rulebook.generated.json`, секція
`Fees, resets, add-ons`). Реалізація — `lib/accounts/reset.ts`.

| Правило §18.2 | Де в коді | Статус (заповни) |
|---|---|---|
| Reset після breach зі знижкою 20% протягом 2 календарних днів | `RESET_DISCOUNT_PCT`, `RESET_DISCOUNT_MS`, `discountPct` | |
| Reset створює новий акаунт з Phase 1 | `provisionReset` → `provisionChallengeAccounts` | |
| Reset не відновлює стару історію/баланс | `resetSourceAccountId` на новому акаунті | |
| Reset не пропонується для frozen | `isFrozenBackup` / `FROZEN_STANDBY` → `'frozen'` | |
| Доступний для активного основного акаунта **і** backup після активації | `status IN BREACHED*` | |
| Не більше 1 reset на продукт за 30 днів | `RESET_INTERVAL_MS`, `resets >= 1` | |
| Недоступний при fraud / sharing / prohibited / друге news / abuse | `ABUSE_PATTERNS` | |
| Reset fee не повертається, не змінює allocation | поза цим файлом | |
| Кілька reset за короткий період → manual review | `requestReview` лише для адмін-reset | |

### 14.2. Що зробити з розбіжностями

1. **Активний акаунт.** Код вимагає `BREACHED*`, рулбук дозволяє reset
   активного акаунта (без знижки). Якщо це підтверджено — дозволь
   `status IN ('ACTIVE','FUNDED')` з `discountPct: 0`, **але** перевір, що
   `resetAccountForPayment` і вебхук не покладаються на «breached» як інваріант.
   Якщо є хоч один такий інваріант — **не змінюй**, опиши ризик у звіті.
2. **Manual review при кількох reset.** Для платного reset з
   `resetSourceAccountId` додай `actionReviewRequestData` (kind `RESET`), якщо в
   трейдера вже був reset іншого продукту за останні 60 днів.
3. **Копірайт модалки.** `ResetAccountDialog`: покажи вікно знижки явно —
   `20% off — valid until {date}` коли `discountPct > 0`, і
   `Standard price — the 20% breach discount has expired` коли `0`. Додай
   рядок про ліміт: `One reset per product every 30 days.`

### 14.3. Приймання пакета 12

- Таблиця з §14.1 заповнена статусами `implemented / partial / missing` з
  `файл:рядок` для кожного.
- Кожна `missing`/`partial` — або виправлена, або описана в звіті з причиною,
  чому виправлення ризиковане.
- `npx tsc --noEmit`, `npm run lint` чисто.

---

## §15. Фінальна перевірка (перед звітом)

```bash
npx tsc --noEmit
npm run lint
npm run build
```

`npm run test:ai-support` у цьому середовищі **червоний і до твоїх змін**
(59 pass / 20 fail / 13 cancelled, `dependencies.loadPricing is not a
function`). Не «лагодь» це і не звітуй як регресію — достатньо переконатися,
що числа не змінились.

Ручні сценарії (обов’язково, по одному рядку на кожен у звіті):

1. Верхня панель на 1280 / 1440 / 1920.
2. Картка ордера: Market з SL/TP, Pending з LIMIT (прапорець off) і з
   STOP/STOP-LIMIT (прапорець on).
3. Чарт: BUY LIMIT синій, SELL LIMIT червоний, SL/TP пунктирні, drag працює.
4. Дві позиції → редагування саме вибраної.
5. Центр сповіщень: поява, сортування, `Open`, `Email` + КД, reload.
6. Перемикання акаунта → інша сторінка → назад; re-login.
7. Billing: `Pay now` без нового рядка; скасування; анімації.
8. Rules monitor: дуги; пороги кольору.

Якщо браузера немає — напиши це прямо, не вигадуй результат.

---

## §16. Шаблон звіту

```
## Що зроблено
| Пакет | Коміт | Файли | Статус |
|---|---|---|---|

## Рішення, які я прийняв сам (з обґрунтуванням)
-

## Що НЕ зроблено і чому
-

## Розбіжності правил (пакет 12)
| Правило §18.2 | Статус | Файл:рядок | Дія |
|---|---|---|---|

## Перевірки
npx tsc --noEmit        → …
npm run lint            → … (N warnings, базово 81)
npm run build           → …
npm run test:ai-support → … (порівняно з базовим 59/20/13)
Ручні сценарії         → …

## Побічні знахідки (не виправляв)
-
```

---

## ДОДАТОК A — палітра й цифри, які не можна міняти

| Що | Значення |
|---|---|
| SL | `#fb923c` (`text-orange-300`) |
| TP | `#22c55e` (`text-emerald-300`) |
| Limit BUY | `#3b82f6` |
| Limit SELL | `#f43f5e` |
| Stop trigger | `#f59e0b` |
| Пороги DD / правила | warning ≥ 50%, danger ≥ 80%, пульс ≥ 90% |
| Поріг email-попередження | 80% (`PROXIMITY_THRESHOLD`) |
| КД ручного листа | 3 / годину, 1 / хвилину |
| Ліміт історії сповіщень | 200 записів |
| Знижка reset | 20% протягом 2 діб |
| Ліміт reset | 1 на продукт / 30 діб |

## ДОДАТОК B — якщо щось не сходиться

- **Не видно, де рендериться елемент** — `grep -rn "<текст>" components/ app/`.
  Не вигадуй новий компонент, якщо поруч уже є потрібний.
- **Правка вимагає нового стану** — спершу подивись, чи він уже є в
  `useTerminalBook` / `useOrderTicketStore`; дублювати стан у двох сторах
  заборонено.
- **Конфлікт із наявним стилем** — перемагає наявний токен, не новий hex.
- **Сумніваєшся, чи це в скоупі** — не роби, запиши в звіт.
