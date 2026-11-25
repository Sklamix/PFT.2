# Промпт для виконавця: переробка чату підтримки PFT (7 правок)

> Це єдиний документ, за яким ти працюєш. Він самодостатній: не шукай додаткових
> інструкцій, не вигадуй фіч поза ним і не «покращуй» сусідній код.
> Якщо щось у документі суперечить коду — пріоритет такий: **1) цей файл,
> 2) `CLAUDE.md`, 3) існуючий код**. Суперечність зафіксуй у PR-описі, не вирішуй мовчки.

---

## 0. Контекст

**Продукт:** PFT.2 — prop-trading платформа. Є чат підтримки у трьох місцях:

| Місце | Файли | Мова UI |
|---|---|---|
| Трейдер (дашборд) | `components/support/trader-support-view.tsx`, `components/support/support-assistant.tsx` | EN |
| Персонал (desk) | `components/admin/support-desk.tsx`, `components/admin/support-agent-panel.tsx` | EN |
| Персонал (APK, Capacitor WebView) | `app/staff/page.tsx`, `app/staff/AgentPanel.tsx` | UA |

**Стек:** Next.js (App Router) + React + TypeScript, Prisma + Postgres (Neon), деплой Vercel, мобільна обгортка Capacitor (`support-app/`, WebView відкриває `https://pft-app-prod.vercel.app/staff`).

**Ключові модулі:**

- API трейдера: `app/api/support/tickets/route.ts`, `app/api/support/tickets/[id]/route.ts`, `app/api/support/tickets/[id]/messages/route.ts`
- API персоналу: `app/api/admin/support/tickets/route.ts`, `app/api/admin/support/tickets/[id]/route.ts`, `.../[id]/messages/route.ts`, `.../[id]/agent/route.ts`, `.../[id]/agent/chat/route.ts`
- Сервісний шар: `lib/support/service.ts`, типи `lib/support/types.ts`, HTTP-хелпери `lib/support/http.ts`
- AI: `lib/ai/support-chat.ts` (handoff), `lib/ai/pft-knowledge.ts` (знання), `lib/ai/assistant-client.ts` (клієнт трейдера)
- Правила: `docs/PFT-rulebook-v1.md` (укр., 827 рядків), версія `lib/rules/version.ts`
- Модель: `prisma/schema.prisma` → `SupportTicket`, `SupportMessage`. **Поле `SupportMessage.metadata Json?` уже існує і призначене саме для AI-метаданих.**

**Перед першим рядком коду зроби обов'язково:**

1. Прочитай `AGENTS.md` і `CLAUDE.md` у корені.
2. Прочитай `node_modules/next/dist/docs/` — у цій версії Next.js є breaking changes відносно твоїх тренувальних даних. Не пиши код «по пам'яті».
3. Переглянь `DESIGN.md` (палітра, типографіка, правило motion 200–320 мс).

---

## 1. Жорсткі правила (порушення = робота не приймається)

1. **Не змінюй `prisma/schema.prisma`.** Міграції в цьому завданні не потрібні.
2. **Не додавай npm-залежностей.** Ні `react-markdown`, ні `framer-motion`, ні `date-fns`, ні `lunr`.
3. **Ніякого WebSocket / SSE / Pusher / Ably / Supabase Realtime.** Тільки HTTP-полінг. Причина: Vercel serverless + Capacitor WebView.
4. **Не ламай наявні контракти API.** Додавати поля можна. Видаляти, перейменовувати, змінювати типи наявних полів — ні.
5. **Не чіпай `lib/ai/pft-knowledge.ts`**, `lib/rules/breach-matrix.ts`, `lib/rules/enforcement.ts` та будь-що в `lib/finance`, `lib/payouts`, `lib/trading`.
6. **Не запускай** `prisma db push`, `db:migrate`, `db:seed`, деплой, `git push`. Ніяких дій проти БД.
7. **Не додавай фіч поза цим документом.** Сумніваєшся — роби найпростішу версію, описану тут, і напиши про це в PR.
8. **Не логи тіла повідомлень і PII.** Тільки коди помилок, статуси, id.
9. **Мова UI не змінюється:** трейдер і desk — англійська, APK — українська. Нові рядки додавай тією ж мовою, що вже в цьому файлі.
10. **a11y обов'язково:** `aria-live="polite"` для нових повідомлень, `aria-label` на іконкових кнопках, керування з клавіатури, видимий `focus-visible`.
11. **Кожен пакет = окремий коміт.** Після кожного пакета: `npm run lint` + зазначені тести зелені. Не переходь до наступного пакета з червоними тестами.
12. **Мінімум коду.** Якщо 200 рядків можна звести до 50 — зводь.

---

## 2. Порядок робіт

Пакети виконуються **строго по порядку**. Кожен наступний спирається на попередній.

| # | Пакет | Правка користувача | Залежить від |
|---|---|---|---|
| 0 | Спільні примітиви чату | — | — |
| 1 | Скрол всередині чату | 1 | 0 |
| 2 | «Talk to a human» за потреби | 3 | 0 |
| 3 | Живі оновлення (полінг) | 2 | 0 |
| 4 | AI-контекст → Brief (шпаргалка) | 4 | 0, 3 |
| 5 | Структуровані AI-повідомлення | 5 | 0, 4 |
| 6 | Анімації | 6 | 0, 1, 3 |
| 7 | Вкладка «Правила» | 7 | 0, 4 |
| 8 | Фінальна перевірка | — | усі |

---

## ПАКЕТ 0 — Спільні примітиви чату

**Мета:** створити 4 маленькі модулі, які далі використовуються в усіх трьох UI. Нічого не підключати до сторінок у цьому пакеті.

### 0.1 `components/support/chat/message-body.tsx`

```ts
export function MessageBody({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'ai' | 'staff' }): ReactElement
```

Рендерер **підмножини** markdown у React-елементи. **Ніколи** не використовуй `dangerouslySetInnerHTML`.

Підтримувані конструкції (і більше нічого):

| Синтаксис | Рендер |
|---|---|
| порожній рядок | новий абзац |
| `- ` або `* ` на початку рядка | `<ul><li>` |
| `1. ` на початку рядка | `<ol><li>` |
| `**жирний**` | `<strong>` |
| `` `код` `` | `<code>` |
| рядок, що починається з `> ` | callout-блок (ліва рамка `border-warning/60`, фон `bg-warning/5`) |
| `## ` / `### ` | лейбл секції (mono, uppercase, 10px, `text-muted-foreground`) |
| рядки `\| a \| b \|` з розділювачем `\|---\|` | `<table>` |

Усе інше — звичайний текст. Посилання, зображення, HTML-теги, вкладені списки — **не підтримуються**, рендеряться як текст.

Стилі: `text-sm leading-relaxed`, `break-words`, таблиця — `w-full text-xs` з `border-border`, комірки `px-2 py-1`, шапка `font-mono uppercase text-[10px]`.

### 0.2 `components/support/chat/typing-dots.tsx`

```ts
export function TypingDots({ label = 'Assistant is typing' }: { label?: string }): ReactElement
```

Три крапки, CSS-анімація з затримкою 0/120/240 мс. Контейнер `role="status"` + `aria-label={label}` + `<span className="sr-only">{label}</span>`. Анімація вимикається через `prefers-reduced-motion` (див. пакет 6, клас `.animate-dot-bounce`; до пакета 6 використовуй інлайн-стиль без анімації — компонент має бути готовий, але статичний).

### 0.3 `hooks/use-stick-to-bottom.ts`

```ts
export function useStickToBottom<T extends HTMLElement>(dep: unknown): {
  ref: React.RefObject<T | null>
  atBottom: boolean
  unread: number
  scrollToBottom: (behavior?: ScrollBehavior) => void
  resetUnread: () => void
}
```

Поведінка:

- слухає `scroll` на своєму елементі; `atBottom = scrollHeight - scrollTop - clientHeight < 48`;
- при зміні `dep`: якщо `atBottom` — `scrollTop = scrollHeight`; інакше `unread += 1`;
- `scrollToBottom()` ставить `scrollTop = scrollHeight` і обнуляє `unread`;
- прибирає слухач на unmount.

### 0.4 `lib/support/live.ts` (чисті функції, без React)

```ts
export function parseSince(value: string | null): Date | null   // null, якщо параметра немає; ValidationError, якщо дата невалідна
export function mergeMessages<T extends { id: string }>(existing: T[], incoming: T[]): T[]
export function latestCreatedAt<T extends { createdAt: string }>(items: T[]): string | null
```

- `parseSince`: `null` або порожній/пробільний рядок → `null` (щоб `?since=` не давав 400). Інакше `new Date(value)`; якщо `Number.isNaN(getTime())` — кинути `ValidationError('Invalid since parameter.')` з `lib/support/types.ts`.
- `mergeMessages`: конкатенація з дедуплікацією за `id`; порядок — як у `existing`, нові в кінці у своєму порядку.
- `latestCreatedAt`: максимальний ISO-рядок або `null`.

### 0.5 Тест `scripts/support-live.test.ts`

`node:test` + `node:assert/strict`. Покрий:

- `parseSince(null) === null`;
- `parseSince('2026-11-25T10:00:00.000Z')` повертає `Date`;
- `parseSince('not-a-date')` кидає `ValidationError`;
- `mergeMessages` не дублює повідомлення з однаковим `id`;
- `mergeMessages` зберігає порядок `existing`;
- `latestCreatedAt([]) === null`, а для масиву повертає найпізніший.

Додай у `package.json`:

```json
"test:support-ui": "node scripts/run-db-free-tests.cjs --import tsx --test scripts/support-live.test.ts"
```

**Acceptance пакета 0:** `npm run lint` зелений, `npm run test:support-ui` зелений, жодна сторінка ще не змінена.

---

## ПАКЕТ 1 — Скрол усередині чату, а не сторінки (правка №1)

**Проблема:** контейнер повідомлень має `flex-1 overflow-y-auto`, але в батьків немає обмеженої висоти, тому `flex-1` не працює, контейнер росте разом із контентом і скролиться `body`.

### 1.1 Трейдер — `components/support/trader-support-view.tsx`

Зміни структуру (класи важливіші за розмітку):

```
<div className="h-dvh overflow-hidden">                       ← було min-h-dvh
  <SpaceBackground />
  <div className="relative z-10 mx-auto flex h-full w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:px-8">
    <header className="shrink-0">…</header>
    <SupportAssistant className="shrink-0" />                  ← новий проп className
    <div className="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section className="… flex min-h-0 flex-col overflow-hidden">   ← список тикетів
        <div className="… shrink-0">фільтр + refresh</div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="… shrink-0">пагінація</div>
      </section>
      <section className="… flex min-h-0 flex-col overflow-hidden">   ← розмова
        <header className="shrink-0">…</header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-4 [scrollbar-gutter:stable]">
        <div className="shrink-0 border-t border-slate-800/80 p-3">форма</div>
      </section>
    </div>
  </div>
</div>
```

Прибрати `max-h-[calc(100dvh-260px)]` зі списку тикетів (рядок ~284) — висоту тепер дає flex.

`SupportAssistant` отримує опційний проп `className?: string` і застосовує його через `cn()` до кореневого `<section>`.

Підключити `useStickToBottom` до контейнера повідомлень: при відкритті тикета й при надходженні нових повідомлень скролити вниз, якщо користувач був унизу.

### 1.2 Desk — `components/admin/support-desk.tsx`

Desk живе всередині `AdminDeskFrame`, де `<main>` росте разом із контентом. **Не змінюй `AdminDeskFrame`** (це зламає інші секції). Замість цього додай хук:

`hooks/use-fill-height.ts`

```ts
export function useFillHeight<T extends HTMLElement>(options?: { minHeight?: number }): {
  ref: React.RefObject<T | null>
  style: React.CSSProperties        // { height: 'XXXpx' }
}
```

- `useLayoutEffect`: `bottomPadding = parseFloat(getComputedStyle(parent).paddingBottom) || 24`; `height = window.innerHeight - ref.getBoundingClientRect().top - bottomPadding`, не менше `minHeight ?? 360`;
- перерахувати на `resize`, `orientationchange` і `visualViewport.resize`;
- до першого виміру `style.height` не заданий (щоб не було стрибка);
- `rect.top` залежить від позиції скролу, тому після пакета 1 сторінка підтримки **не повинна** скролитись узагалі. Якщо вона все ще скролиться — це баг розкладки, а не привід перераховувати висоту на `scroll`.

Застосувати на `div.grid` (рядок ~363): `ref={ref} style={style}` + `className="grid min-h-0 gap-3 …"`. Колонки:

- список: `flex min-h-0 flex-col overflow-hidden`; скрол-контейнер `min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]` (прибрати `max-h-[calc(100dvh-260px)]`);
- розмова: `flex min-h-0 flex-col overflow-hidden`; повідомлення `min-h-0 flex-1 overflow-y-auto overscroll-contain`; форма `shrink-0`;
- права колонка (Agent panel): `min-h-0 overflow-y-auto` — їй теж потрібен власний скрол, інакше вона розтягне сітку.

### 1.3 APK — `app/staff/page.tsx`

У режимі відкритого тикета:

```
<div className="flex h-dvh flex-col overflow-hidden bg-deck">
  <header className="shrink-0 …">…</header>
  <main className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col px-4 py-4">
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">повідомлення</div>
    <div className="shrink-0 pt-3">AgentSection + форма</div>
  </main>
</div>
```

Прибрати `sticky bottom-4` у форми — форма тепер поза скролом.

### 1.4 Acceptance пакета 1

- Відкрий тикет із 30+ повідомленнями: скролиться **тільки** блок повідомлень; шапка, список тикетів, форма відповіді й (у трейдера) панель асистента стоять на місці; скрол не «протікає» на сторінку (`overscroll-contain`).
- На екрані 1280×720 і на 390×844 (мобільний) нічого не обрізане, форма завжди видима.
- При відкритті тикета список показує останнє повідомлення (скрол унизу).
- Якщо користувач прокрутив угору і прийшло нове повідомлення — скрол **не** стрибає.

---

## ПАКЕТ 2 — «Talk to a human» лише коли AI не впорався (правка №3)

**Проблема:** кнопка рендериться завжди (`components/support/support-assistant.tsx`, блок `flex flex-col gap-1` під формою).

### 2.1 Прибрати постійну кнопку

Видалити `<Button type="button" variant="ghost" … onClick={() => void talkToHuman()}>Talk to a human</Button>` з-під кнопки «Ask». Функцію `talkToHuman()` **залишити** — вона викликатиметься з нового місця.

### 2.2 Стан «коли показувати»

Додати в компонент:

```ts
const [failedTurns, setFailedTurns] = useState(0)
```

- `failedTurns += 1`, коли відповідь прийшла без `answer` і без `handoff` (тобто `suggestedHandoff`), або коли `send()`/`talkToHuman()` кинули помилку;
- `failedTurns = 0` після відповіді з `data.answer`.

Показувати посилання, якщо `failedTurns >= 1`:

```tsx
<Button type="button" variant="link" size="xs" className="h-6 px-0 text-[11px] text-muted-foreground"
        disabled={sending} onClick={() => void talkToHuman()}>
  Talk to a human
</Button>
```

Розмістити під полем введення, ліворуч, не як основну дію.

### 2.3 Картка підтвердження (уже є) — не дублювати

Блок `suggestedHandoff` з кнопками «Yes, pass to agent» / «No» лишається як є. Він і є основним шляхом ескалації.

### 2.4 Заборонено

- Не видаляй `forceHandoff` з `lib/ai/assistant-client.ts` і з `app/api/support/ai/chat/route.ts`.
- Не змінюй серверну логіку `handleSupportChat` у цьому пакеті.
- Не додавай автоескалацію «через N секунд».

### 2.5 Acceptance пакета 2

- Свіжий чат: видно лише «Ask», жодної кнопки ескалації.
- Питання поза правилами → з'являється картка «I could not answer this from the official rules» + посилання «Talk to a human».
- Симулюй помилку (DevTools → Offline) → після помилки посилання з'являється.
- Успішна відповідь скидає `failedTurns` → посилання зникає.
- `npm run test:ai-support` зелений.

---

## ПАКЕТ 3 — Живі оновлення в обидві сторони (правка №2)

**Рішення: HTTP-полінг дельти. Без SSE/WebSocket.** Причини: Vercel serverless (кожне довге з'єднання = інстанс функції), Capacitor WebView (у `support-app/README.md` прямо сказано, що пуші в WebView не працюють).

### 3.1 Розширити сервіс — `lib/support/service.ts`

Додати опційний параметр `since?: Date | null` у:

```ts
export async function getTraderTicket(userId: string, ref: string, pagination: { page: number; pageSize: number }, since?: Date | null)
export async function getStaffTicket(ref: string, pagination: { page: number; pageSize: number }, since?: Date | null)
```

Логіка, коли `since` переданий:

- `where: { ticketId, createdAt: { gte: since } }` — саме `gte`, не `gt`, щоб не загубити повідомлення з тим самим таймстемпом (клієнт дедуплікує за `id`);
- `orderBy: { createdAt: 'asc' }`, `take: pageSize`, без `skip`;
- `total` — як і раніше, повний `count` по тикету;
- у відповідь додати `hasMore: items.length === pageSize`.

Коли `since` не переданий — поведінка **не змінюється** (пагінація як зараз), але `hasMore` додається завжди (`items.length === pageSize`).

### 3.2 Роути

`app/api/support/tickets/[id]/route.ts` і `app/api/admin/support/tickets/[id]/route.ts`:

```ts
const since = parseSince(new URL(request.url).searchParams.get('since'))
const result = await getTraderTicket(session.sub, id, pagination, since)
```

`parseSince` кидає `ValidationError` — наявний `handleSupportError` уже мапить його на 400. Нічого додатково не лови.

`Cache-Control: no-store` уже стоїть — лишити.

### 3.3 Хук `hooks/use-support-poll.ts`

```ts
export function useSupportPoll(options: {
  getUrl: () => string | null   // викликається ПЕРЕД кожним запитом; null = пропустити тік
  enabled?: boolean             // default true
  intervalMs?: number           // default 3000
  hiddenIntervalMs?: number     // default 15000; 0 = пауза, коли вкладка прихована
  onData: (data: unknown) => void
  onError?: (error: Error) => void
}): { refresh: () => void; polling: boolean }
```

> Чому `getUrl`, а не `url`: курсор `since` змінюється після кожного мерджу, а `ref` не викликає ре-рендер. Якщо передати готовий рядок, він «застрягне» на початковому значенні. Функція ж обчислюється на кожному тіку.

Вимоги до реалізації:

- ланцюжок `setTimeout`, **не** `setInterval` (щоб працював backoff);
- `AbortController` на кожен запит; `AbortError` ігнорується;
- guard від паралельних запитів (ref);
- `onData`/`onError` тримай у ref, щоб зміна колбека не перезапускала таймер;
- `document.addEventListener('visibilitychange')`: приховано → інтервал `hiddenIntervalMs`; повернулись → негайний `refresh()`;
- помилка → інтервал `min(interval * 2, 30_000)`, успіх → скидання;
- cleanup: `clearTimeout` + `abort()` + зняти слухач.

### 3.4 Підключення

**Трейдер** (`trader-support-view.tsx`):

- `sinceRef = useRef<string | null>(null)` — оновлюється через `latestCreatedAt()` після кожного завантаження/мерджу;
- полінг вибраного тикета:

```ts
useSupportPoll({
  getUrl: () => {
    if (!selectedId) return null
    const params = new URLSearchParams({ pageSize: '50' })
    if (sinceRef.current) params.set('since', sinceRef.current)   // порожній since не передаємо
    return '/api/support/tickets/' + encodeURIComponent(selectedId) + '?' + params.toString()
  },
  intervalMs: 3000,
  onData: (raw) => { /* mergeMessages + оновити detail.ticket */ },
})
```

- в `onData`: привести `raw` до `TicketDetail`, `mergeMessages(detail.messages.items, incoming.items)`, оновити `detail.ticket` і `sinceRef.current = latestCreatedAt(merged)`; якщо `hasMore` — повний `loadDetail(selectedId, messagePage)`;
- **не** показуй `detailLoading` для фонових оновлень (це спінер на весь екран);
- список тикетів: окремий `useSupportPoll` з `intervalMs: 15000`, `hiddenIntervalMs: 0`, повний refetch (`getUrl` повертає URL списку).

**Desk** (`support-desk.tsx`):

- той самий патерн для вибраного тикета (`/api/admin/support/tickets/...`), `intervalMs: 3000`, свій `sinceRef`, який скидається в `openTicket()`;
- список — `intervalMs: 15000`, `hiddenIntervalMs: 0`; зберігати `selectedId` і не скидати `detail` при фоновому оновленні списку;
- прибрати необхідність натискати «Refresh» (кнопку лишити).

**APK** (`app/staff/page.tsx`):

- відкритий тикет — `intervalMs: 4000`, свій `sinceRef`;
- список — замінити наявний `setInterval(30_000)` на `useSupportPoll`, щоб була пауза при прихованому екрані.

### 3.5 Заборонено

- Не роби оптимістичних повідомлень у цьому пакеті (це пакет 6).
- Не змінюй `intervalMs` «щоб було плавніше» — 3000/15000 зафіксовані.
- Не додавай нових ендпоінтів: дельта їде через наявний `GET [id]`.

### 3.6 Acceptance пакета 3

- Два вікна: трейдер і desk. Повідомлення трейдера з'являється в desk ≤ 4 с без перезавантаження; відповідь персоналу з'являється у трейдера ≤ 4 с.
- APK/WebView: те саме.
- Повідомлення не дублюються після 10 циклів полінгу.
- Вкладка прихована → запитів немає (Network tab); повернулись → один негайний запит.
- Помилка мережі → інтервал росте, у консолі немає спаму.
- Зміна статусу тикета (RESOLVED) підтягується без перезавантаження.

---

## ПАКЕТ 4 — AI-контекст не потрапляє трейдеру; персонал отримує Brief (правка №4)

**Проблема:** `lib/ai/support-chat.ts` → `handoffBody()` збирає великий службовий блок («Message from the PFT assistant chat», «AI handoff reason», «Conversation context», «Trader context (server-side)», «Rules version») і зберігає його як **перше повідомлення трейдера**. Трейдер це бачить.

### 4.1 Нова форма metadata — `lib/support/brief.ts`

```ts
export type SupportBrief = {
  source: 'agent' | 'user' | 'system'
  reason: string
  category: string
  rulesVersion: string
  history: { role: 'user' | 'assistant'; content: string }[]
  context: {
    kycStatus: string
    accounts: { displayId: string; status: string; planSize: number; phase: string }[]
  }
}

export function readBrief(metadata: unknown): SupportBrief | null
```

`readBrief` — строгий валідатор: повертає `null`, якщо хоч одне поле не тієї форми. Ніколи не кидає.

### 4.2 Змінити `lib/ai/support-chat.ts`

- **Видалити** `handoffBody()` і `conversationExcerpt()` повністю (без мертвого коду).
- Побудувати `brief: SupportBrief`:

```ts
const brief: SupportBrief = {
  source: input.handoffSource ?? 'user',
  reason: finalReason,
  category,
  rulesVersion: RULES_SOURCE_VERSION,
  history: input.history.slice(-4).map((turn) => ({ role: turn.role, content: turn.content.replace(/\s+/g, ' ').slice(0, 400) })),
  context: {
    kycStatus: context?.kycStatus ?? 'unknown',
    accounts: (context?.accounts ?? []).slice(0, 3),
  },
}
```

- Обидва шляхи (`createTicket` і `addTraderMessage`) отримують:
  - `body: input.message` — **тільки текст трейдера**, без префіксів;
  - `messageMetadata: { source: brief.source, brief }`.

`handoffSubject()` не чіпати.

> **Важливо:** перший рядок більше не містить причини. Це навмисно — причина їде в `metadata.brief`.

### 4.3 Віддати brief персоналу

`lib/support/types.ts`:

```ts
export type StaffTicketMessage = TicketMessage & {
  senderName: string | null
  senderEmail: string | null
  metadata: unknown | null
}
```

`lib/support/service.ts` → `getStaffTicket`: у `select` додати `metadata: true`, у мапінгу — `metadata: message.metadata ?? null`.

`getTraderTicket` **не змінювати** — metadata трейдеру не віддається (це вже правильно).

### 4.4 UI: вкладка Brief

`components/admin/support-agent-panel.tsx`:

- `type AgentTab = 'snapshot' | 'brief' | 'assist' | 'history'` (пакет 7 додасть `'rules'`);
- нові пропи:

```ts
export function SupportAgentPanel({ ticketId, brief, onInsertReply }: {
  ticketId: string
  brief: SupportBrief | null      // приходить ззовні, панель НЕ робить власний запит повідомлень
  onInsertReply?: (text: string) => void
}): ReactElement
```

`brief` передає батько, бо `SupportDesk` уже має `detail.messages.items` — дублювати запит не треба. Панель лише рендерить те, що отримала.

Вміст вкладки (порядок зверху вниз):

1. Чип причини: `<span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-[9px] uppercase text-warning">{brief.reason}</span>` + `category` + `rulesVersion`.
2. «Why the AI handed off» — текст `reason` людською мовою (якщо це код на кшталт `not_covered_by_rules` — показати як є, не перекладати).
3. «Last turns» — міні-діалог: `Trader: …` / `Assistant: …`, `MessageBody` для контенту, `max-h-40 overflow-y-auto`.
4. «Trader context» — KYC-бейдж + список акаунтів (`displayId · status · $planSize · phase`), `font-mono text-[10px]`.
5. Кнопки: **Copy** (`navigator.clipboard.writeText` зібраного тексту) і **Insert into reply** (`onInsertReply?.(text)`).

Якщо `brief === null` — показати `No AI brief on this ticket.` (тикет створено вручну).

`components/admin/support-desk.tsx`:

```tsx
<SupportAgentPanel
  ticketId={selectedId}
  brief={readBrief(detail?.messages.items[0]?.metadata)}
  onInsertReply={(text) => setDraft((current) => (current.trim() ? current + '\n\n' + text : text))}
/>
```

`app/staff/AgentPanel.tsx` + `app/staff/page.tsx`: те саме, але стилі APK (`card`, `btn`, `input` константи вже є у файлі). `openTicket` уже тримає `messages`, тож `readBrief(messages[0]?.metadata)`.

### 4.5 Бекфіл старих тикетів — `scripts/support-brief-backfill.ts`

- За замовчуванням **dry-run**: нічого не пише, друкує `found / convertible / skipped`.
- `--apply` — виконує запис.
- Знаходить повідомлення, у яких `body` починається з `Message from the PFT assistant chat:`.
- Розбирає блоки за маркерами: `AI handoff reason:`, `Conversation context (most recent turns):`, `Trader context (server-side):`, `KYC:`, `Accounts (newest first, max 3):`, `Rules version:`.
- Новий `body` = текст між першим маркером і `AI handoff reason:` (обрізаний).
- Новий `metadata` = `{ source: 'agent', brief: { … } }`; історію парсити з рядків `Trader: …` / `Assistant: …`; акаунти — з рядків `- DISPLAYID · STATUS · $PLAN · PHASE`.
- Якщо розбір не вдався — **не чіпати** повідомлення, лічити в `skipped`.
- Ніяких `console.log` із тілами повідомлень — тільки id і лічильники.

Додати в `package.json`: `"support:backfill-brief": "tsx scripts/support-brief-backfill.ts"`.

### 4.6 Acceptance пакета 4

- Новий handoff: у трейдера в тикеті видно **лише своє питання**, без «AI handoff reason» і без «Trader context».
- У desk вкладка Brief показує причину, останні репліки, KYC, акаунти, версію правил.
- «Insert into reply» вставляє текст у поле відповіді.
- Старий тикет після `--apply` виглядає так само, як новий; до `--apply` — не змінюється.
- `npm run test:ai-support` зелений (контракт handoff не зламано).

---

## ПАКЕТ 5 — Структуровані AI-повідомлення (правка №5)

**Проблема:** AI-відповіді рендеряться як `<p className="whitespace-pre-wrap">`. Форматування немає ні на вході (промпт), ні на виході (рендер).

### 5.1 Формат відповіді агента — `app/api/admin/support/tickets/[id]/agent/chat/route.ts`

У `systemInstruction` замінити рядок `'where proposedActions lists only the tools you recommend. Keep the reply concise.'` на:

```
'where proposedActions lists only the tools you recommend.',
'Format the "reply" field as plain text (no HTML, no code fences, max 12 lines) in exactly this shape:',
'**Summary:** one sentence that answers the question.',
'**Facts:**',
'- 2 to 4 short facts, one per line, each starting with "- ".',
'**Next step:** what the agent should do or tell the trader.',
'**Source:** Rules v1.6 §<section> — only when a rule applies, otherwise omit this line.',
'Use **bold** only for the four labels. Keep numbers as digits. Never invent data outside the snapshot.',
'Write the body in the language the agent used; keep the four labels in English exactly as given.'
```

> Лейбли англійською навмисно: desk — англомовний, а лейбли структурні. Тіло відповіді йде мовою запиту агента (у APK це буде українська).

JSON-обгортку `{ "reply": string, "proposedActions": [...] }` **не змінювати** — її парсить клієнт.

### 5.2 Рендер

Замінити `<p className="whitespace-pre-wrap">{turn.content}</p>` / `{message.body}` на `<MessageBody text={...} tone={...} />` у:

- `components/admin/support-desk.tsx` (список повідомлень, рядок ~569);
- `components/admin/support-agent-panel.tsx` (Assist, рядок ~326);
- `app/staff/AgentPanel.tsx` (Assist, рядок ~313);
- `components/support/support-assistant.tsx` (репліки асистента, рядок ~209);
- `components/support/trader-support-view.tsx` (рядок ~389).

`tone`: `'ai'` для `senderType === 'AI'` і для реплік асистента; `'staff'` для `STAFF`; `'neutral'` для трейдера.

### 5.3 Візуальна ієрархія

- AI-повідомлення в desk: ліва рамка `border-l-2 border-primary/50`, фон `bg-primary/5`, лейбл `AI` (mono 9px uppercase) — щоб візуально відрізняти від людини.
- STAFF — як зараз (справа, `bg-primary/10`).
- TRADER — зліва, `bg-secondary/40`.
- Критичні значення в тексті не підсвічуй автоматично — це робить модель через `**bold**` і `> ` callout. Автоматичне фарбування чисел **заборонено** (хибні спрацювання на сумах і відсотках).

### 5.4 Acceptance пакета 5

- Запитай агента в desk → відповідь рендериться секціями з маркованим списком, без видимих `**`.
- Відповідь з `> ` показується як callout.
- Таблиця в тексті рендериться як таблиця.
- HTML у відповіді моделі **не** виконується (перевір: `<script>alert(1)</script>` у тексті лишається текстом).
- Трейдерський чат з асистентом виглядає так само охайно.

---

## ПАКЕТ 6 — Анімації (правка №6)

**Обмеження з `DESIGN.md`:** motion рідкісний, 200–320 мс, тільки `transform`/`opacity`, завжди з `prefers-reduced-motion`.

### 6.1 `app/globals.css`

Додати поруч із наявними (`marquee`, `step-in`, `journal-*`), у тому ж стилі:

```css
@keyframes chat-panel-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dot-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.45; } 30% { transform: translateY(-4px); opacity: 1; } }
@keyframes pill-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes skeleton-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.8; } }
```

Класи: `.animate-chat-panel-in` (200ms ease-out), `.animate-msg-in` (180ms cubic-bezier(0.22,1,0.36,1) both), `.animate-dot-bounce` (1.1s infinite, затримки через `nth-child`), `.animate-pill-in` (160ms), `.animate-skeleton` (1.4s infinite).

Для кожного — блок `@media (prefers-reduced-motion: reduce) { … animation: none; }`.

### 6.2 Де застосувати

| Елемент | Анімація |
|---|---|
| Панель асистента при відкритті | `animate-chat-panel-in` |
| Кожне повідомлення у списку | `animate-msg-in` + `style={{ animationDelay: Math.min(index, 6) * 40 + 'ms' }}` |
| Очікування відповіді AI/агента | `<TypingDots />` замість спінера в кнопці (спінер лишити всередині кнопки) |
| Пігулка «↓ New messages» | `animate-pill-in` |
| Завантаження списку тикетів | 3 skeleton-рядки замість тексту `Loading…` |
| Бейдж непрочитаних | `animate-pill-in` |

Тригери для `TypingDots`: у трейдера — `sending === true`; у desk/APK Assist — `sending`/`chatBusy === true`. Це **реальний** стан запиту, не імітація.

### 6.3 Заборонено

- Не анімуй висоту, `margin`, `padding`, `width` — тільки `transform`/`opacity`.
- Не анімуй сам текст відповіді по символах (typewriter) — це ламає читання й копіювання.
- Не додавай крапки «співрозмовник пише» між людиною й агентом: для цього потрібен окремий typing-сигнал, якого немає. Показуй крапки тільки для власного in-flight запиту.
- Не додавай анімацій на hover, яких не було.

### 6.4 Acceptance пакета 6

- Відкриття чату — плавна поява ≤ 200 мс.
- Під час запиту видно крапки, після відповіді — зникають.
- З `prefers-reduced-motion: reduce` (DevTools → Rendering) нічого не рухається, контент доступний.
- Немає layout shift: після появи повідомлення текст під курсором не «стрибає».

---

## ПАКЕТ 7 — Вкладка «Правила» (правка №7)

**Джерело:** `docs/PFT-rulebook-v1.md` — внутрішній регламент v1.6, 827 рядків, українською. Версія: `lib/rules/version.ts` (`RULES_VERSION`, `RULES_EFFECTIVE_DATE`).

**Не парси markdown у рантаймі.** Генеруй JSON на білді й комітуй його.

### 7.1 `scripts/build-rulebook.ts`

- Читає `docs/PFT-rulebook-v1.md` (UTF-8, зняти BOM).
- Розбиває на секції за `^## (\d+)\.\s*(.+)$`. Підсекції (`### n.m`) лишаються всередині `markdown`.
- **Виключає** секції з номерами: `0`, `25`, `26`, `27`, `28`.
  Причина: `0` — філософія продукту, `25` — порівняння з конкурентами, `26` — «що треба доробити» (беклог), `27` — маркетингові формулювання, `28` — відхилені рішення. Це не правила, і агент не має на них натрапляти.
- Включає `1–24` і `29`.
- Пише `lib/rules/rulebook.generated.json`:

```json
{
  "version": "1.6",
  "effective": "2026-10-27",
  "sourceHash": "sha256:<hex>",
  "sections": [
    { "id": "6", "num": 6, "title": "Max overall drawdown", "markdown": "...", "keywords": ["drawdown", "trailing", "..."] }
  ]
}
```

- `keywords`: унікальні слова з `title` + `markdown`, нижній регістр, довжина ≥ 4, ліміт 40.
- Формат JSON — 2 пробіли, стабільний порядок ключів (щоб diff був читабельним).
- `sourceHash` — sha256 вмісту `.md` (нормалізовані `\r\n` → `\n`).

`package.json`: `"rules:build": "tsx scripts/build-rulebook.ts"`.

### 7.2 Тест `scripts/rulebook-build.test.ts`

- Перерахувати хеш `.md` і порівняти з `sourceHash` у JSON → якщо різні, тест падає з повідомленням `Rulebook changed — run npm run rules:build`.
- Перевірити, що в JSON немає секцій `0`, `25`, `26`, `27`, `28`.
- Перевірити, що кожна включена секція має непорожній `markdown` і `title`.
- Перевірити, що `version` у JSON збігається з `RULES_VERSION` з `lib/rules/version.ts`.

`package.json`: `"test:rulebook": "node scripts/run-db-free-tests.cjs --import tsx --test scripts/rulebook-build.test.ts"`.

### 7.3 UI `components/support/rules-browser.tsx`

```ts
export function RulesBrowser({ onInsert }: { onInsert?: (text: string) => void }): ReactElement
```

- Імпортує JSON статично: `import rulebook from '@/lib/rules/rulebook.generated.json'`.
- Шапка: `Rules v{version} · effective {effective}` (mono 10px). Якщо `rulebook.version !== RULES_VERSION` — банер `border-warning/40 bg-warning/10`: «AI knowledge version differs from the rulebook».
- Пошук: `<input>` з `placeholder="Search rules…"`, фільтр по `title + markdown + keywords` (lowercase `includes`). Порожній запит — усі секції.
- Чипи швидких категорій (мапінг на номери секцій): `Drawdown` → 5,6; `Payouts` → 17; `KYC` → 21; `News` → 9; `Prohibited` → 14; `Fees` → 18; `Breach` → 19. Клік ставить запит у пошук.
- Список: кожна секція — `button` з `aria-expanded`, заголовок `§{num} {title}`, контент — `<MessageBody text={section.markdown} />` при розкритті. За замовчуванням усе згорнуто.
- Підсвітка збігів: обгортай знайдений підрядок у `<mark className="bg-highlight/25 text-foreground">` **тільки в заголовку** (у тілі не треба — зайвий шум).
- Кнопка «Вставити у відповідь» у розкритій секції → `onInsert?.('§' + num + ' ' + title + '\n' + markdown)`.
- Порожній результат: `No rules match "…".`

### 7.4 Підключення вкладки

`components/admin/support-agent-panel.tsx`: `AgentTab` → `'snapshot' | 'brief' | 'assist' | 'history' | 'rules'`; у `<nav>` додати пункт `rules`; рендер `<RulesBrowser onInsert={onInsertReply} />`.

`app/staff/AgentPanel.tsx`: третій чип «Правила» поруч із «Дані клієнта» / «Агент (Assist)»; той самий компонент.

### 7.5 Заборонено

- Не створюй API-ендпоінт для правил — дані статичні й уже в бандлі.
- Не показуй виключені секції «про всяк випадок».
- Не редагуй `docs/PFT-rulebook-v1.md` (це юридичний документ).

### 7.6 Acceptance пакета 7

- Вкладка «Правила» відкривається в desk і в APK.
- Пошук «drawdown» знаходить §5 і §6; «payout» — §17.
- Секції 25/26/27/28 відсутні.
- «Вставити у відповідь» кладе текст у поле відповіді.
- Змінив `.md` без `npm run rules:build` → `npm run test:rulebook` падає з підказкою.

---

## ПАКЕТ 8 — Фінальна перевірка

### 8.1 Команди (усі мають бути зелені)

```bash
npm run lint
npx tsc --noEmit
npm run test:support-ui
npm run test:rulebook
npm run test:ai-support
npm run rules:build && git diff --exit-code lib/rules/rulebook.generated.json
```

Остання команда перевіряє, що згенерований файл закомічений і актуальний.

### 8.2 Ручний сценарій (виконати й описати результат у PR)

1. Трейдер відкриває Support, ставить питання поза правилами.
2. Перевіряє: немає постійної кнопки «Talk to a human»; з'явилась картка пропозиції передачі.
3. Підтверджує → створюється тикет. У тикеті видно **тільки** питання трейдера.
4. Desk: тикет з'явився без перезавантаження (≤ 15 с для списку). Відкриває тикет → вкладка Brief показує причину/контекст.
5. Desk відповідає → у трейдера відповідь з'являється ≤ 4 с, без перезавантаження.
6. Трейдер відповідає → у desk з'являється ≤ 4 с.
7. Обидві сторони: скролиться тільки блок повідомлень.
8. Desk: Assist → відповідь структурована (секції + список), без `**`.
9. Desk: вкладка Rules → пошук працює, insert працює.
10. APK (або `/staff` у мобільному емуляторі): усе те саме, скрол і полінг працюють.
11. `prefers-reduced-motion: reduce` → анімацій немає.

### 8.3 Що здати

- 8 комітів (по одному на пакет 0–7) з описами.
- PR-опис: що зроблено, які рішення прийняті, що **не** зроблено і чому.
- Скріншоти: desk Brief, desk Rules, структурована AI-відповідь, чат трейдера без службового тексту.

---

## ДОДАТОК A — Журнал рішень (не переглядай їх — вони узгоджені)

| Питання | Рішення | Чому |
|---|---|---|
| Realtime | HTTP-полінг 3 с / 15 с | Vercel serverless + WebView; SSE тримає інстанс функції |
| `since` | `gte`, не `gt` | не загубити повідомлення з однаковим таймстемпом; дедуп на клієнті за `id` |
| Brief | `SupportMessage.metadata` | поле вже існує, міграція не потрібна |
| Рендер markdown | власний `MessageBody` | без нових залежностей, повний контроль стилів, безпечно |
| Правила | JSON на білді | нуль рантайм-вартості, працює офлайн в APK, тест на свіжість |
| Виключені секції правил | 0, 25, 26, 27, 28 | це беклог/маркетинг, не правила |
| «Talk to a human» | прихована, показується після невдачі | не блокувати трейдера, коли AI недоступний |
| Типінг-крапки | тільки для власного запиту | немає сигналу «співрозмовник пише»; імітація = брехня в UI |

---

## ДОДАТОК B — Anti-scope (якщо зробиш — відкоти)

- Нові таблиці/поля Prisma, будь-які міграції.
- Нові npm-пакети.
- WebSocket/SSE/Redis/Pusher.
- Автоматичне фарбування чисел і «розумна» підсвітка тексту.
- Typewriter-ефект для відповідей.
- Рефакторинг `AdminDeskFrame`, `admin-desk.tsx`, навігації, інших секцій.
- Зміна `lib/ai/pft-knowledge.ts`, `lib/rules/*` (крім нового `rulebook.generated.json`).
- Публічна сторінка правил для трейдерів.
- Переклад регламенту англійською.
- Будь-які дії з продакшн-БД.

---

## ДОДАТОК C — Якщо чогось не вистачає

1. Спочатку пошукай у коді (`Grep`), не питай.
2. Якщо рішення все одно немає — обери **найпростіший** варіант, що задовольняє Acceptance цього пакета.
3. Запиши рішення в розділ «Прийняті рішення» PR-опису.
4. Не зупиняй роботу через дрібницю; зупиняйся тільки якщо суперечність стосується схеми БД, безпеки або контракту API.
