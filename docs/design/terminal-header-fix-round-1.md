# FIX ROUND 1 — шапка терміналу: 5 розбіжностей з референсом

Референс: скріншот 1920×640. Поточний результат: скріншот терміналу.
Нижче — тільки те, що реально розходиться. Кожен пункт перевірений по коду
і, де можливо, заміряний піксельно.

## Що вже добре — НЕ ЛАМАЙ

- `AccountBar`: пілюля-селект, синій «Account», градієнтна «New Challenge», «Sign out» — збігається.
- Бокс SYMBOL `210×52`, `rounded-xl`, `#0B1224` — збігається.
- Кольори: `#307DFD` / `#E14C55` / `#00B774` / `#8FA3C4` — збігаються.
- `EQUITY` 40px, `BALANCE | FREE MARGIN` у ряд із роздільником — правильно.
- Прогрес-бар `h-2.5` (10px), `rounded-full`, логіка порогів — правильно.
- `<dl>/<dt>/<dd>`, `role="meter"`, усі store-селектори — не чіпай.

---

## D1 — зони метрик не є картками (головне)

**Де:** `components/terminal/TerminalHeader.tsx`, функція `MetricCard` і `<dl>` навколо зон.

**Зараз:**

```tsx
function MetricCard({ children, divider = false }) {
  return (
    <div className={cn('relative min-w-0 overflow-hidden px-6 py-5',
      divider && 'border-t border-white/[0.06] lg:border-t-0 lg:border-l')}>
      {children}
    </div>
  )
}
```

```tsx
<dl className="grid min-w-0 grid-cols-1 lg:grid-cols-[42%_11.5%_minmax(0,1fr)]">
```

**Наслідок:** це не три картки, а одна суцільна смуга, порізана волосяними лініями.
Замір по скріншоту: на висоті середини карток фон суцільний `#080E1C` від лівого
до правого краю — жодного розриву, жодного заокруглення.

**У референсі:** три окремі картки з `rounded-2xl`, власною межею і зазором **26px**
між ними, крізь який просвічує фон сторінки.

**Треба:**

```tsx
<dl className="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-[26px]">
```

```tsx
function MetricCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      'relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080E1C] px-6 py-5',
      className,
    )}>
      {children}
    </div>
  )
}
```

Ширини повісити на самі картки:

- equity: `lg:basis-[42%] lg:shrink-0`
- margin: `lg:basis-[11.5%] lg:shrink-0`
- buffer: `lg:flex-1`

Параметр `divider` і всі `border-l` видалити повністю.

---

## D2 — світіння планети не читається

**Де:** `TerminalHeader.tsx`, зона A (EQUITY), `div` з `radial-gradient`.

**Зараз:**

```tsx
style={{ background: 'radial-gradient(ellipse at 92% 118%, rgba(66,120,205,0.55), transparent 58%)' }}
className="pointer-events-none absolute inset-0 opacity-50"
```

**Замір:** усередині картки фон `#080E1C`, біля правого краю максимум `#0B1224`.
Дельта ~8 по синьому каналу — це невидимо. У референсі видно **чіткий лімб планети**
з яскравою дугою, що виходить за край картки.

**Треба:** два шари замість одного.

```tsx
{/* заливка */}
<div aria-hidden="true" className="pointer-events-none absolute inset-0"
  style={{ background: 'radial-gradient(120% 130% at 100% 125%, rgba(56,116,214,0.40), transparent 62%)' }} />

{/* лімб планети — коло, зсунуте за правий-нижній кут */}
<div aria-hidden="true"
  className="pointer-events-none absolute -right-[38%] -bottom-[70%] aspect-square w-[125%] rounded-full"
  style={{ background:
    'radial-gradient(circle at 50% 50%, #080E1C 0 58%, rgba(150,200,255,0.65) 60.5%, rgba(70,130,215,0.25) 65%, transparent 72%)' }} />
```

Вимоги:

- `overflow-hidden` на картці вже є — лімб має обрізатись краєм, не вилазити.
- Перевір контраст: у лівій половині картки (де цифра EQUITY) фон не має
  освітлюватись більш ніж на ~6% за яскравістю, інакше синя цифра втратить читабельність.

---

## D3 — пілюля LIVE · INDICATIVE SPREAD невидима

**Де:** `TerminalHeader.tsx`, рядок ~52.

**Зараз:**

```tsx
<div className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-5 overflow-x-auto">
```

**Наслідок:** пілюля статусу фіду виштовхується за правий край контейнера
і обрізається `overflow-x-auto` без скролбара. На скріншоті її немає взагалі,
хоча в коді вона рендериться. У референсі вона стоїть одразу після бейджа акаунта.

**Треба:**

```tsx
<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2">
```

Прибрати `flex-nowrap` і `overflow-x-auto`. Якщо на 1280 не влазить — хай переноситься,
але пілюля мусить бути видима.

**Перевірка:** у DOM після бейджа акаунта є видимий елемент із текстом
`Live · indicative spread` (або `Market closed` / статус з'єднання).

---

## D4 — роздільники між котируваннями притиснуті до чисел

**Де:** `QuoteStack` і контейнер з `divide-x`.

**Зараз:** `divide-x divide-white/[0.06]` стоїть на контейнері, але `QuoteStack`
(BID, ASK) не має горизонтального padding, тоді як SPREAD і 24H мають `px-4`.
Лінія виходить впритул до числа.

**Треба:** дати `QuoteStack` `px-4`; першій колонці — `pl-0`, останній — `pr-0`.
Лінія має стояти рівно посередині між сусідніми числами.

---

## D5 — замалий відступ зовнішньої картки

**Де:** `TerminalWorkspace.tsx`, обгортка навколо `AccountBar` + `TerminalHeader`.

**Зараз:** `mx-3 mt-3` (12px).

**Треба:** `mx-6 mt-6` (24px) і додати `mb-3`, щоб картка не липла до контенту знизу.

---

## НЕ ДЕФЕКТИ — не виправляй

Це стан даних, а не помилка верстки:

- **Немає цифри на бейджі NOTIFICATIONS** — `unread === 0`, бейдж рендериться лише при `unread > 0`.
- **Немає рядка під кнопкою NOTIFICATIONS** — рендериться з `lastItem`, а сповіщень немає.
  У референсі там «New challenge is processing...» — це `lastItem.message`.
- **FUNDED замість BREACHED_DAILY**, **MARGIN $199.35 замість $0.00** — реальний стан акаунта.

Перевіряй ці три речі з активним сповіщенням і акаунтом у статусі breach,
але **не** хардкодь їх.

---

## ПЕРЕВІРКА ПЕРЕД ЗДАЧЕЮ

```
npx tsc --noEmit
npm run lint
npm run test:trading
```

Візуально, на 1920 і на 1280:

- [ ] Три окремі картки із заокругленням 16px і зазором 26px, крізь зазор видно фон
- [ ] У картці EQUITY видно дугу планети, текст читається
- [ ] Пілюля `Live · indicative spread` видима одразу після бейджа акаунта
- [ ] Вертикальні лінії між BID/ASK/SPREAD/24H стоять рівно між числами
- [ ] На 1280 нічого не обрізається і немає горизонтального скролу
- [ ] Числа живі: перемикання акаунта оновлює equity/margin/buffer

Скріншот — обов'язково.
