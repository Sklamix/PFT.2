# Промпт для виконавця: три правки термінала PFT

> Це єдиний документ, за яким ти працюєш. Він самодостатній: не шукай додаткових
> інструкцій, не вигадуй фіч поза ним і не «покращуй» сусідній код.
> Якщо щось у документі суперечить коду — пріоритет такий: **1) цей файл,
> 2) `CLAUDE.md` + `DESIGN.md`, 3) існуючий код**. Суперечність зафіксуй у PR-описі,
> не вирішуй мовчки.

---

## 0. Контекст

**Продукт:** PFT.2 — prop-trading платформа. Трейдерський термінал: чарт (lightweight-charts),
тікет ордера, таблиця позицій, менеджер сповіщень.

**Стек:** Next.js 16 (App Router) + React 19 + TypeScript, Zustand, Tailwind v4,
Prisma + Postgres (Neon), деплой Vercel. **У цій сесії нічого не деплоїш і не пушиш у `main`.**

**Файли, з якими працюєш:**

| Файл | Роль |
|---|---|
| `components/terminal/TradingChart.tsx` | чарт, рівні (SL/TP/ліміти), drag, SVG-бейджі |
| `components/terminal/PositionsTable.tsx` | таблиця позицій, вибір позиції, інлайн-редагування SL/TP |
| `components/terminal/OrderPanel.tsx` | тікет ордера (Market / Limit), статус котирувань |
| `components/terminal/TerminalWorkspace.tsx` | монтування термінала, `loadStoredTimeZone()` |
| `components/terminal/TerminalHeader.tsx` | годинник термінала + селектор таймзони |
| `lib/stores/useTerminalBook.ts` | `selectedPositionId`, `selectPosition`, `protectionDraft` |
| `lib/stores/useTimezoneStore.ts` | zustand-стан таймзони + localStorage/cookie |
| `lib/settings/timezones.ts` | `TIMEZONE_OPTIONS`, `isSupportedTimeZone` |
| `components/settings/preferences-panel.tsx` | збереження таймзони в налаштуваннях |
| `app/api/auth/me/route.ts` | сесія трейдера (сюди додаси таймзону) |

**Перед першим рядком коду обов'язково:**

1. Прочитай `AGENTS.md`, `CLAUDE.md`, `DESIGN.md` у корені.
2. Прочитай `node_modules/next/dist/docs/` — у цій версії Next.js є breaking changes
   відносно твоїх тренувальних даних. Не пиши код «по пам'яті».
3. Запусти `npm run dev` і **відтвори кожен із трьох дефектів у браузері до того,
   як щось змінювати**. Правка, зроблена без відтворення, не приймається.

---

## 1. Жорсткі правила (порушення = робота не приймається)

1. **Схема БД не змінюється.** Жодних `prisma/schema.prisma`, `prisma/sql/*.sql`,
   `ALLOWED_SQL_FILES`. Ці три правки — суто клієнтські + один read-only поля в API.
2. **Не чіпай** білінг, платежі, AI-підтримку, правило-бук, reset акаунта, `middleware.ts`.
3. **Кольори — тільки з `DESIGN.md` / `lib/terminal/level-tone.ts`.** Не вигадуй нових
   hex. Для «неактивного» стану використовуй `moon-mist #8fa3c4`.
4. **Жодного `any`, жодного `@ts-ignore`.** `npx tsc --noEmit` мусить бути чистий.
5. `npm run lint` — **0 errors** (попередження не додавати).
6. UI термінала — **англійською**. Коментарі в коді — англійською, коротко, по суті.
7. Один commit на одну правку, повідомлення у стилі
   `fix(chart): …`, `fix(order-ticket): …`, `fix(settings): …`.
8. **Не переписуй** файл цілком, якщо можна змінити функцію. Діф має читатися.

---

## 2. Правка 1 — позиція на чарті має два стани: «не вибрана» і «вибрана»

### 2.1 Що зараз

Відкрита позиція на чарті **завжди** виглядає активною: лінії SL і TP пофарбовані
(оранжевий/зелений), бейджі показують P/L, і лінії **завжди** можна тягнути мишею —
навіть коли в таблиці не вибрано жодного рядка. Трейдер не може зрозуміти, яку саме
позицію він зараз редагує, бо «активними» виглядають усі.

Очікування трейдера (з двох скріншотів):

- **Стан A — не вибрана.** Позиція на чарті = одна тонка **сіра** лінія на ціні входу
  з маленькою сірою пігулкою `BUY`/`SELL`; SL/TP — такі самі сірі, тонкі, пунктирні,
  **без кольору і без P/L**. Нічого не тягнеться.
- **Стан B — вибрана** (клік по лінії або по рядку в таблиці). Лінія і SL/TP стають
  кольоровими, з'являється P/L у бейджі, лінії можна тягнути.

### 2.2 Корінь проблеми (знайдено, не шукай заново)

`components/terminal/TradingChart.tsx`, функція `activePositionFor()` (~рядки 97–110):

```ts
if (selected) return selected
let active: Position | null = null
for (const position of positions) {
  if (position.symbol !== symbol || position.status !== 'OPEN') continue
  if (!active || position.openedAt.getTime() > active.openedAt.getTime()) active = position
}
return active            // ← ось дефект
```

Коли `selectedPositionId === null`, чарт сам підставляє **найновішу** позицію по символу
і далі малює її SL/TP як активні. Звідси «постійно підсвічується і дає себе редагувати».

Другий шар: у `buildChartLevels()` (~рядки 174–208) рівні SL/TP для цієї позиції
отримують `color: LEVEL_HEX.sl / LEVEL_HEX.tp` і `dashed: draft != null` — тобто колір
не залежить від вибору взагалі.

Третій шар: у рендері `renderedLevels` (~рядки 1221–1255) кожен рівень безумовно має
`role="slider"`, `onPointerDown={startDrag}`, `cursor-ns-resize` — тобто будь-яка лінія
тягнеться, навіть якщо вона «нічия».

### 2.3 Має бути

**Джерело істини — `selectedPositionId` у `useTerminalBook`.** Він уже є, уже
встановлюється кліком по рядку (`PositionsTable`, `onClick={() => selectPosition(position.id)}`)
і вже очищується, коли позиції більше немає. Нічого нового в стор додавати не треба,
крім одного: **скидання `protectionDraft` при зміні вибору** (див. 2.5).

Стани рівня позиції:

| | Стан A — не вибрана | Стан B — вибрана |
|---|---|---|
| Лінія входу | `#8fa3c4`, opacity ~0.55, dashed, width 1 | колір сторони: `LEVEL_HEX.limitBuy` (BUY) / `LEVEL_HEX.limitSell` (SELL), solid |
| SL | `#8fa3c4` ~0.55, dashed, width 1 | `LEVEL_HEX.sl` (`#fb923c`), solid |
| TP | `#8fa3c4` ~0.55, dashed, width 1 | `LEVEL_HEX.tp` (`#22c55e`), solid |
| Бейдж | сіра рамка, тільки `SL`/`TP` + ціна | кольорова рамка, `SL`/`TP` + ціна + `±$X · ±N points` |
| Курсор | `cursor-pointer` | `cursor-ns-resize` |
| Роль | `role="button"`, `aria-label="Select … position"` | `role="slider"` + `aria-valuenow/min/max` |
| Клік | **вибирає** позицію (`selectPosition`) | починає drag |
| Клавіатура | `Enter`/`Space` → вибрати | `↑`/`↓` — крок, `Enter` — застосувати, `Escape` — скасувати |

Додатково:

1. **Лінія входу.** У поточному коді `TradingChart.tsx` рівня входу немає взагалі —
   будуються лише `limit`/`stop`/`sl`/`tp`. Додай `kind: 'entry'` на `position.entryPrice`
   з бейджем-пігулкою `BUY`/`SELL` (компактною, без ціни) — це і є та «палка», по якій
   трейдер клікає. Якщо на чарті вже видно схожу сіру лінію на ціні останньої угоди
   (типова дефолтна `priceLine` бібліотеки) — розведи їх: лінія входу має бути явно
   підписана, щоб не читалась як та сама.
2. **Клік по порожньому місцю чарта** знімає вибір (`selectPosition(null)`), як і `Escape`
   на фокусі чарта. Не знімай вибір під час drag, під час малювання (інструмент != `cursor`)
   і при кліку по самій лінії.
3. **Draft-рівні тікета** (`buildDraftLevels`, прев'ю SL/TP до відкриття позиції)
   лишаються інтерактивними **завжди** — вони не належать позиції. Не ламай їх.
4. **Pending-ордери** (`kind: 'limit' | 'stop'`) не змінюються взагалі.

### 2.4 Де змінювати

- `components/terminal/TradingChart.tsx`:
  - `activePositionFor()` — прибрати фолбек на найновішу позицію; без вибору повертати `null`.
  - `ChartLevel` — додати `interactive?: boolean` (default `true`) і `muted?: boolean`.
  - `buildChartLevels()` — будувати рівні позиції завжди, але для невибраної позиції
    ставити `muted: true`, `interactive: false`, `color: MUTED_LEVEL`, `dashed: true`,
    і **не** передавати `draftEntry`/`draftSide` у бейдж (щоб не рахувати P/L).
  - `levelBadge()` — для `muted` повертати `{ title, price, detail: '' }`.
  - `startDrag()` — `if (level.interactive === false) { selectPosition(level.position.id); return }`.
  - `renderedLevels` — розгалуження `role`/`cursor`/`aria-*` за `muted`/`interactive`.
  - `clampDragPrice()`, `commitLevel()` — без змін логіки, лише переконайся, що для
    `muted` вони недосяжні.
  - Обробник кліку по фону чарта (`wrapperRef`) — зняття вибору.
- `components/terminal/PositionsTable.tsx`:
  - клік по вже вибраному рядку знімає вибір (toggle), а не «нічого не робить»;
  - при зміні `selectedPositionId` — `setEditingId(null)` і `setProtectionDraft(null)`,
    щоб покинута чернетка не висіла на іншій позиції.
- `lib/stores/useTerminalBook.ts` — нічого, крім перевірки, що `selectPosition` не
  «залипає» після `sync()`.

### 2.5 Критерії приймання (перевіряються в браузері, не «на око по діфу»)

1. Відкрий позицію. Нічого не вибрано → на чарті **немає жодної кольорової лінії**:
   лінія входу сіра, SL/TP сірі й пунктирні, бейджі без `$` і без слів `drag to modify`.
2. Наведи на сіру лінію SL — курсор `pointer`, не `ns-resize`. Спробуй потягнути —
   нічого не рухається.
3. Клік по сірій лінії входу → вона і SL/TP стають кольоровими, у бейджі з'являється
   `±$X · ±N points`, лінії тягнуться, `↑`/`↓` працюють з клавіатури.
4. Клік по порожньому місцю чарта або `Escape` → повертається стан A.
5. Клік по рядку в таблиці → той самий перехід у стан B; повторний клік по рядку →
   стан A.
6. Дві відкриті позиції на одному символі: у стані A **обидві** сірі; вибір однієї
   фарбує лише її.
7. Відкрий нову позицію кнопкою Buy/Sell у тікеті → вона з'являється **сірою**
   (нічого не вибрано). Це важливо: раніше «найновіша» автоматично ставала активною.
8. Прев'ю SL/TP у тікеті до відкриття позиції працює як раніше: кольорове, тягнеться,
   з грошима в бейджі.
9. Редагування SL/TP через олівець у таблиці, як і раніше, малює пунктирні лінії
   `SL · editing` / `TP · editing` на чарті.
10. `Escape` під час drag скасовує переміщення, а не знімає вибір.

---

## 3. Правка 2 — «Waiting for a fresh market quote» не має розтягувати тікет

### 3.1 Що зараз

`components/terminal/OrderPanel.tsx`, кінець тікета (~рядки 513–515):

```tsx
{tradable && connectionStatus !== 'CONNECTED' ? (
  <p className="font-mono text-[11px] text-warning">Waiting for a fresh market quote — orders disabled</p>
) : null}
```

Це `<p>` у flex-колонці **під** кнопкою `Execute trade`. Коли котирування зникає й
повертається (а це відбувається постійно), рядок то з'являється, то зникає → висота
панелі стрибає, кнопка й поля нижче зсуваються. Той самий ефект має сусідній блок
`Account … — orders disabled` (~рядки 508–512).

### 3.2 Має бути

Обидва повідомлення переходять у **шапку тікета** (`OrderPanel`, блок
`<div className="border-b border-border px-4 py-3">` з `Order ticket` / `{meta.name}`)
як компактний індикатор стану, який **не впливає на висоту** панелі в жодному стані.

Вимоги:

1. Індикатор живе в шапці, вирівняний праворуч від назви інструменту
   (наприклад `flex items-start justify-between gap-2` + `shrink-0`), висота шапки
   фіксована — при появі/зникненні тексту панель не змінює розмірів.
2. Вигляд: крапка 6px + короткий підпис `text-[9px] uppercase tracking-wide`,
   `max-w-[7.5rem] truncate`. Стани:
   - `CONNECTED` → крапка `text-primary`, підпис `LIVE`;
   - `CONNECTING` → крапка `text-warning`, підпис `SYNCING`;
   - `DISCONNECTED` / `ERROR` → крапка `text-warning`, підпис `NO QUOTE`.
3. Повний текст (`Waiting for a fresh market quote — orders disabled` та
   `Account … — orders disabled`) зберігається в `title` і `aria-label`, щоб сенс не
   загубився. Ніяких тултіп-бібліотек — нативний `title`.
4. Доступність: контейнер `role="status"`, `aria-live="polite"`.
5. **Не** переносити це в `NotificationCenter` — це прямо заборонено.
6. Блоки `<p>` під кнопкою видалити повністю. `notice` (результат виконання ордера)
   лишається де є — це інше повідомлення, воно реакція на дію, а не стан потоку.

### 3.3 Критерії приймання

1. Відключи живлення котирувань (DevTools → offline або зупини воркер) → у шапці тікета
   з'являється `NO QUOTE`. Висота панелі **не змінюється** — перевір `offsetHeight`
   у консолі до і після.
2. Поверни котирування → `LIVE`, висота та сама.
3. `title` на індикаторі показує повне речення.
4. `Execute trade` не зсувається ні на піксель у всіх трьох станах.

---

## 4. Правка 3 — таймзона з налаштувань не доходить до термінала

### 4.1 Що зараз

У налаштуваннях стоїть `Kyiv (GMT+2)` (зберігається в БД успішно — після перезавантаження
селект показує Kyiv), а годинник у шапці термінала показує `UTC · GMT` і час UTC.

Причин три, і всі три треба закрити:

1. **`components/settings/preferences-panel.tsx` (~рядок 43)** після успішного збереження
   робить лише:
   ```ts
   window.localStorage.setItem('pft-terminal-timezone', data.preferences.timeZone)
   window.dispatchEvent(new Event('pft-timezone-change'))
   ```
   — і **не оновлює zustand-стор**. Будь-який уже змонтований термінал лишається зі
   старим значенням.
2. **Подію `pft-timezone-change` ніхто не слухає.** `grep -rn "pft-timezone-change"`
   дає рівно один рядок — той, що її відправляє. Механізм мертвий.
3. **Немає синхронізації між вкладками.** `storage`-подію ніхто не обробляє, тому
   зміна в одній вкладці не доходить до термінала в іншій (а трейдери тримають
   термінал відкритим постійно).
4. Додатково: `/api/auth/me` не повертає таймзону, тому на новому пристрої
   до першого збереження в цьому браузері термінал показує UTC.

### 4.2 Має бути

`lib/stores/useTimezoneStore.ts` — єдине джерело істини для клієнта:

```ts
export function syncTimeZone(value: string) {
  if (!isSupported(value)) return
  useTimezoneStore.setState({ timeZone: value })
  try { window.localStorage.setItem(TIMEZONE_STORAGE_KEY, value) } catch {}
}

/** Підписки: cross-tab + внутрішня подія. Викликати один раз з TerminalWorkspace. */
export function subscribeTimeZone() {
  const onStorage = (event: StorageEvent) => {
    if (event.key === TIMEZONE_STORAGE_KEY && event.newValue) syncTimeZone(event.newValue)
  }
  const onCustom = () => {
    try { syncTimeZone(window.localStorage.getItem(TIMEZONE_STORAGE_KEY) ?? '') } catch {}
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('pft-timezone-change', onCustom)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('pft-timezone-change', onCustom)
  }
}
```

Зміни по файлах:

1. `lib/stores/useTimezoneStore.ts` — додати `syncTimeZone` і `subscribeTimeZone` (вище).
   `setTimeZone` лишається як є (він і так пише localStorage). Експортувати `MUTED`-ні
   речі не треба.
2. `components/settings/preferences-panel.tsx` — замінити прямий `localStorage.setItem`
   на `useTimezoneStore.getState().setTimeZone(data.preferences.timeZone)`; подію
   `pft-timezone-change` лишити (вона тепер має слухача).
3. `app/api/auth/me/route.ts` — додати в відповідь `timeZone` з `getUserPreferences`
   (функція вже існує: `lib/settings/preferences.ts`). Read-only, без зміни схеми.
4. `components/terminal/TerminalWorkspace.tsx`:
   - в ефекті монтування — `loadStoredTimeZone()` (уже є) **і** `return subscribeTimeZone()`;
   - у `loadTrader()` після успішної відповіді — якщо прийшов `timeZone`, застосувати
     його через `syncTimeZone` (сервер — джерело істини для акаунта, він перекриває
     застарілий localStorage на цьому пристрої);
   - на `visibilitychange` (вкладка знову активна) — перечитати збережене значення,
     щоб повернення у стару вкладку не лишало UTC.
5. `components/dashboard/EconomicCalendar.tsx` — за замовчуванням (коли в пікері
   вибрано `local`) брати зону зі стора, а не `Intl…resolvedOptions().timeZone`.
   Налаштування обіцяє «Used for the terminal clock, calendar and security history» —
   зараз календар це ігнорує.

**Обмеження, які не можна порушити:**

- Не читати `localStorage` під час рендера — шапка рендериться на сервері з `UTC`, і
  будь-яке читання в рендері дасть hydration mismatch. Тільки ефекти.
- `timeZoneOffsetLabel()` навмисно нормалізує `GMT+0` → `GMT` (Node і Chrome рендерять
  по-різному). Не прибирай цю нормалізацію.
- `PositionsTable` і `TradingChart` уже читають `useTimezoneStore` — вони підхоплять
  зміну самі, окремих правок не потребують.

### 4.3 Критерії приймання

1. Налаштування → Timezone → `Kyiv (GMT+2)` → Save. **Не перезавантажуючи сторінку**,
   перейди в термінал → годинник показує `Kyiv · GMT+2` і місцевий час (UTC+2).
2. Термінал у вкладці A, налаштування у вкладці B → зміна зони в B одразу оновлює
   годинник у A (без перезавантаження).
3. Зміна зони в A, повернення в B (focus) → B теж показує нову зону.
4. Новий браузер/інкогніто з тим самим акаунтом → після логіну термінал показує
   збережену в акаунті зону, а не UTC.
5. Вісь часу на чарті, колонка `TIME` у таблиці позицій і календар показують час
   у вибраній зоні.
6. Після hard reload немає помилок гідратації в консолі (React не викидає дерево).

---

## 5. Перевірка перед здачею

```bash
npx tsc --noEmit
npm run lint
npm run build
npm run test:trading
npm run test:support-ui
```

Плюс ручний прогін усіх чек-листів із розділів 2.5, 3.3, 4.3 у браузері.

**Не роби:** `git push`, `vercel --prod`, будь-які міграції БД. Здаєш локально:
три commit-и + короткий звіт.

---

## 6. Звіт (обов'язковий, у кінці)

Напиши в чат рівно це:

1. Три commit-хеші й один рядок на кожен — що змінено.
2. Скріншот або відео стану A і стану B чарта (до/після).
3. `offsetHeight` панелі тікета в трьох станах (`LIVE` / `NO QUOTE` / `SYNCING`).
4. Що показав годинник після кожної з п'яти перевірок таймзони (п. 4.3).
5. Якщо якийсь пункт **не** вдалося — прямо напиши «не зроблено, причина: …».
   Не пиши «готово», якщо не перевірив у браузері.
