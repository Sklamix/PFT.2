# Промпт для воркера: калібрування відмов AI-підтримки

> Один послідовний промпт. Виконуй пакети **по порядку**, коміт на кожен пакет.
> Нічого не додавай «від себе»: якщо чогось немає в цьому документі — це поза скоупом.

---

## §0. Що сталося (діагноз, не припущення)

Трейдер запитав **«Як мені заморозити акаунт?»**. Асистент відповів карткою
«I could not answer this from the official rules. Pass this to a human?».
Після натискання **No** і повідомлення «алооо» — на те саме питання відповів
правильно:

> «У PFT немає кнопки заморозки в інтерфейсі трейдера. Заморожений backup
> створюється під час оформлення замовлення (checkout) як опція «+50% до fee».
> Після покупки frozen backup-акаунт автоматично потрапляє у стан FROZEN_STANDBY…»

Тобто знання є, гейт його не ріже, але **перший раз відповідь не дійшла**.

### Що вже перевірено (не перепроводжуй, але й не ламай)

| Гіпотеза | Результат |
|---|---|
| Ретрив різний для двох запитів | **Ні.** `selectSections('Як мені заморозити акаунт?')` і той самий запит з `\nалооо` дають ідентичний набір: `§16 §18 §8 §17 §1` (7429 символів) |
| §0 не потрапляє в промпт | **Ні.** `buildPftKnowledge` завжди додає §0 і §30, разом 8474 символи |
| §0 не можна цитувати | Виправлено раніше: `citableSections()` включає §0 і §30, `verifyCitations` їх приймає |
| Модель не викликається | **Ні.** `sections.length === 5`, ранній handoff не спрацьовує |

### Дві реальні причини

**Причина A — claim-guard блокує правильні відповіді (доведено).**
`lib/ai/claim-guard.ts` вважає будь-яку згадку теми порушенням, а «негаціями»
вважає лише закритий список словоформ. Прогнав 20 природних коректних
формулювань — **3 заблоковано**:

```
BLOCKED  Функція заморозки недоступна трейдеру.
BLOCKED  Заморозити акаунт через кабінет не вийде.
BLOCKED  Ви не можете заморозити акаунт самостійно.
```

І навпаки — 2 справжні галюцинації **проходять**, бо патерни задані повними
словоформами, а не основами:

```
MISSED   Виплата надходить на вимогу протягом години.      (патерн /on-demand/, а в тексті «на вимогу»)
MISSED   Після breach ми розблокуємо акаунт на запит.        (патерн /розблокувати/, а в тексті «розблокуємо»)
```

Тобто фільтр одночасно **занадто строгий** (карає правильне) і **занадто
м'який** (пропускає вигадане). Саме тому перша відповідь пішла в handoff, а
друга — ні: модель сформулювала інакше, і інша форма влучила в білий список.

**Причина B — промпт не каже, що «функції немає» — це відповідь (не доведено,
але усувається дешево).** У `SUPPORT_SYSTEM_INSTRUCTIONS` три гачки для handoff
і жодного явного дозволу відповідати негативним фактом:

- рядок 128: «If the facts do not clearly answer the question, set resolved=false»;
- рядок 132: «Never perform or promise account actions: … close accounts … If asked to do so, set resolved=false and hand off»;
- рядок 143: «For questions about the product interface … hand off to a human unless the section 0 facts explicitly describe the interface».

Питання «Як мені заморозити акаунт?» читається як (а) інтерфейсне, (б) про
дію з акаунтом. Обидва гачки ведуть у handoff, а §0 («The trader chat has NO
Freeze, pause or close button») формально не «описує інтерфейс», а описує його
**відсутність**. Модель щоразу вирішує це сама — звідси нестабільність.

**Що не можна виключити без логів:** збій провайдера (`ai_unavailable`) — у UI
та сама картка. Пакет 4 робить цю різницю видимою; після нього причина кожного
handoff-а буде в аудиті.

### Відтворення (запусти до змін, щоб побачити те саме)

```bash
cat > .probe.ts <<'EOF'
import { findForbiddenClaims } from './lib/ai/claim-guard'
import { selectSections } from './lib/ai/grounding'
import { citableSections } from './lib/ai/pft-knowledge'
const citable = citableSections(selectSections('Як мені заморозити акаунт?'), [])
const correct = [
  'Функція заморозки недоступна трейдеру.',
  'Заморозити акаунт через кабінет не вийде.',
  'Ви не можете заморозити акаунт самостійно.',
]
for (const a of correct) console.log(findForbiddenClaims(a, citable).map(h => h.id), '<-', a)
EOF
npx tsx .probe.ts
rm .probe.ts
```

Очікувано: три рядки з `['trader_freeze_feature']`.

---

## §1. Жорсткі правила

1. **Не чіпай `verifyCitations`** (`lib/ai/grounding.ts`) — це єдина перевірка без
   хибних спрацювань. Її поведінка має лишитись байт-у-байт.
2. **Не роби гейт «м'яким».** Відповідь, що згадує неіснуючу функцію
   ствердно, має блокуватись. Мета — не «менше блоків», а «блоки лише там, де
   твердження справді хибне».
3. **Не видаляй і не послаблюй існуючі тести.** Якщо тест падає — або код
   неправильний, або тест описував стару поведінку; у другому випадку
   перепиши тест і **поясни це в коміті**.
4. **Без нових npm-залежностей, без змін у `prisma/schema.prisma`.**
5. **Один пакет = один коміт.** Повідомлення коміту: `pkg N: <що зроблено>`.
6. **Не чіпай** `.gitignore`, `CLAUDE.md`, `android/`, `support-app/` — там чужі
   зміни.
7. Якщо після пакета `npm run test:ai-grounding` стає червоним — пакет не
   завершений.

### Файли, які ти будеш читати

| Файл | Навіщо |
|---|---|
| `lib/ai/claim-guard.ts` | патерни і негації, які замінюєш |
| `lib/ai/support-chat.ts` (~436–450) | місце, де викликається гейт |
| `lib/ai/pft-knowledge.ts` (~119–143) | системні інструкції |
| `lib/ai/grounding.ts` | `normalizeForMatch`, `citableSections`-контракт |
| `components/support/support-assistant.tsx` (~236) | текст картки handoff |
| `app/api/admin/support/ai-audit/route.ts` | аудит |
| `scripts/ai-claim-guard.test.ts`, `scripts/ai-support-grounding.test.ts` | тести |

---

## §2. Порядок пакетів

| Пакет | Що | Залежить від |
|---|---|---|
| 1 | Промпт: відсутність — це відповідь | — |
| 2 | Заміна claim-guard на інваріант «неіснуюча функція» | — |
| 3 | Числа: тільки логування (без блокування) | 2 |
| 4 | Діагностика: причина handoff-а в аудиті + честний текст у UI | 1, 2 |
| 5 | Фікстури + фінальна перевірка | 1–4 |

---

## §3. Пакет 1 — промпт: відсутність це відповідь

**Файл:** `lib/ai/pft-knowledge.ts`, масив `SUPPORT_SYSTEM_INSTRUCTIONS`.

> Номери рядків нижче — орієнтир станом на коміт `5434ce5`. Шукай елемент **за
> текстом**, а не за номером: після першої вставки номери зсуваються.

### 3.1. Замінити правило про інтерфейсні питання

Було:

```
'For questions about the product interface ("where is X?", "how do I use Y?"): hand off to a human unless the section 0 facts of the prompt explicitly describe the interface.',
```

Стало (рівно один елемент масиву):

```
'Interface questions ("where is X?", "how do I use Y?"): answer from §0 whenever §0 mentions the element — including when §0 says the element does NOT exist. Hand off only when §0 says nothing about that element at all.',
```

### 3.2. Додати правило про негативний факт

Одразу **після** рядка 131 (`'Do not hand off a question that the facts can answer…'`) вставити:

```
'A documented absence is an answer. When §0 or a rulebook section states that a feature does not exist, that statement IS the answer: say plainly that it does not exist, cite that sentence, and set resolved=true. Never hand off a "does X exist?" or "how do I X?" question that the facts answer with "no".',
```

### 3.3. Звузити правило про дії з акаунтом

Було:

```
'Never perform or promise account actions: do not void profit, close accounts, change balances, approve payouts or lift breaches. If asked to do so, set resolved=false and hand off.',
```

Стало:

```
'Never perform or promise account actions: do not void profit, close accounts, change balances, approve payouts or lift breaches. This covers requests to act on a specific account; it does not cover "how does X work" or "does X exist" questions. If asked to act, set resolved=false and hand off.',
```

### 3.4. Явно перелічити цитовані номери

У рядок, що починається з `'Citations: when you state a factual sentence…'`, додати в кінець речення:

```
' Every section number you may cite appears in this request: §0 (platform facts), §30 (pricing) and the rulebook sections listed above. Never cite a section that is not in this request; cite §0 for anything about the interface.',
```

Формулювання навмисно привʼязане до «того, що є в цьому запиті», а не до
діапазону 1–24: `selectSections` дає 3–5 секцій, і цитата з невибраної секції
впаде з `unknown_section` → handoff.

### 3.5. Два приклади (few-shot)

Додати **в кінець** `SUPPORT_SYSTEM_INSTRUCTIONS` двома елементами:

```
'Example — Q: "Як мені заморозити акаунт?" → answer: "У PFT немає кнопки заморозки: заморозити акаунт самостійно неможливо." resolved=true, citations=[{section: 0, quote: "The trader chat has NO Freeze, pause or close button."}].',
'Example — Q: "Скільки коштує акаунт 25000?" → answer lists every plan variant for that size with its base fee, resolved=true, citations point at §30. A price answer is never a handoff.',
```

**Заборонено:** додавати в промпт нові факти про продукт. Приклади — лише
перефразування того, що вже є в §0/§30/рулбуку.

### 3.6. Приймання пакета 1

- `npx tsc --noEmit` чисто.
- У `scripts/ai-prompt-grounding.test.ts` додати 2 тести:
  - промпт містить підрядок `'A documented absence is an answer'`;
  - промпт **не** містить `'hand off to a human unless the section 0 facts'`.
- `npm run test:ai-grounding` зелений.

---

## §4. Пакет 2 — claim-guard: один інваріант замість списку тем

**Файл:** `lib/ai/claim-guard.ts` — переписати `CLAIM_RULES` і `findForbiddenClaims`.

### 4.1. Інваріант

> Якщо речення згадує функцію, якої в продукті **немає**, воно мусить бути
> заперечним. Ствердна згадка такої функції — вигадка, за визначенням.

Це прибирає потребу вгадувати «чи це інструкція»: правильна відповідь про
відсутність завжди містить заперечення, хибна — ніколи.

### 4.2. Дані

```ts
/** Features the product does not have. Every entry must be provable from §0. */
export const ABSENT_FEATURES: { id: string; patterns: RegExp[] }[] = [
  { id: 'freeze', patterns: [/замороз/i, /фріз/i, /freeze/i] },
  { id: 'pause', patterns: [/пауз/i, /призупин/i, /(?<![a-z])pause(?![a-z])/i] },
  { id: 'self_close', patterns: [/закрит\p{L}*\s+акаунт/iu, /блокуван\p{L}*\s+акаунт/iu, /terminat\p{L}*/i] },
  { id: 'on_demand_payout', patterns: [/on-?demand/i, /на\s+вимогу/i, /миттєв\p{L}*\s+виплат/iu] },
  { id: 'refund', patterns: [/поверн\p{L}*[^.]{0,40}(fee|кошт|грош)/iu, /refund\s+(fee|add-?on)/i] },
  { id: 'unlock', patterns: [/розблок\p{L}*/iu, /віднов\p{L}*\s+акаунт/iu] },
]
```

Патерни — **основи**, не словоформи. Саме через словоформи попередня версія
пропускала «розблокуємо» і «на вимогу».

`refund` навмисно дозволяє до 40 символів між дієсловом і обʼєктом: інакше
«Ми повернемо вам fee» не ловиться.

> **Пастка, на якій легко втратити годину.** У JS `\b` не працює з кирилицею
> (`\w` — це лише ASCII), а `\p{L}` діє **тільки** з флагом `u`. Тому:
> `/\bне\s+/` ніколи не зматчить «не можна», а `/розблок\p{L}*/i` без `u`
> шукає буквально «розблокp{L}». Кожен патерн із `\p{L}` мусить мати `u`,
> а межі слова для кирилиці — через `(?<!\p{L})` / `(?!\p{L})`.

### 4.3. Заперечення

```ts
const NEGATION: RegExp[] = [
  /немає/i, /(?<!\p{L})нема(?!\p{L})/iu, /відсутн/i, /неможлив/i, /недоступн/i, /жодн/i,
  // будь-яке «не + дієслово» — це заперечення
  /(?<!\p{L})не\s+\p{L}{0,3}(мож|вий|прац|підтрим|передбач|доступ|існу|має|мають|дав|дає|дають|буде|будуть|став|роб)/iu,
  /(?<![a-z])not(?![a-z])/i, /(?<![a-z])no(?![a-z])/i, /(?<![a-z])never(?![a-z])/i,
  /(?<![a-z])none(?![a-z])/i, /isn'?t/i, /doesn'?t/i, /don'?t/i,
]
```

**Не додавай** голий `/\bне\b/` (він і не спрацює через кирилицю) і не додавай у
список дієслово `торг`: тоді «не торгуйте» стане запереченням і пропустить
пораду простоювати.

### 4.4. Хто виконує дію

Для `self_close` окремо: якщо речення приписує закриття адміністратору,
підтримці або автоматиці — це правильне формулювання, а не самообслуговування.

```ts
const NOT_SELF_SERVICE = [/адміністратор/i, /підтримк/i, /автоматичн/i, /виконує/i]
```

Застосовувати **лише** до `self_close`. Без цього «Закриття акаунта виконує
підтримка.» блокувалось би, хоча це правда з §0.

### 4.5. Функція

```ts
/** Advice to idle the account until it is closed — the rulebook says the opposite. */
const INACTIVITY_ADVICE =
  /(подбайте|достатньо|просто|варто)\b[^.]{0,60}(неактивн|не\s+торгуй|не\s+входь|не\s+заходь)/iu

export type ClaimHit = { id: string; reason: string; match: string }

export function findForbiddenClaims(answer: string, grounded?: { markdown: string }[]): ClaimHit[] {
  const groundedText = (grounded ?? []).map((section) => normalizeForMatch(section.markdown))
  const hits: ClaimHit[] = []
  const seen = new Set<string>()
  for (const sentence of sentences(answer)) {
    // 1. A verbatim quotation of the citable text is never a claim.
    const normalized = normalizeForMatch(sentence)
    if (normalized.length > 0 && groundedText.some((text) => text.includes(normalized))) continue
    // 2. Any negation makes the sentence a denial, not an assertion.
    if (NEGATION.some((pattern) => pattern.test(sentence))) continue
    // 3. Advice to idle the account is wrong even without naming a feature.
    if (INACTIVITY_ADVICE.test(sentence)) {
      hits.push({ id: 'inactivity_as_advice', reason: 'Inactivity closure is a consequence of the rule, not a tactic to close an account.', match: sentence.slice(0, 120) })
      continue
    }
    // 4. An affirmative mention of a feature that does not exist.
    for (const feature of ABSENT_FEATURES) {
      if (!feature.patterns.some((pattern) => pattern.test(sentence))) continue
      if (feature.id === 'self_close' && NOT_SELF_SERVICE.some((pattern) => pattern.test(sentence))) continue
      const key = `${feature.id}:${sentence.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ id: feature.id, reason: `The product has no ${feature.id}; an affirmative mention is a fabrication.`, match: sentence.slice(0, 120) })
    }
  }
  return hits
}
```

Порядок перевірок — частина контракту, не стиль: спершу «дослівна цитата»
(вона вже перевірена `verifyCitations`), потім заперечення, потім порада
простоювати, і лише потім згадка функції. Перестав — отримаєш або хибні
блокування, або пропущені галюцинації.

### 4.6. Приймання пакета 2

`scripts/ai-claim-guard.test.ts`:

- **усі 20** фраз із ДОДАТКА A → `0` хітів (це головний тест пакета);
- **усі 8** фраз із ДОДАТКА B → `> 0` хітів, з правильним `id`;
- зберегти наявний тест «дослівна цитата рулбука не карається»;
- додати тест: `findForbiddenClaims('Щоб закрити акаунт, просто не торгуйте 90 днів.')` → хіт
  `inactivity_as_advice` (доводить, що «не торгуйте» не стало запереченням).

`npm run test:ai-grounding` зелений.

**Еталон, якого треба досягти** (ця логіка прогнана перед написанням промпта):

| Перевірка | Результат |
|---|---|
| ДОДАТОК A (20 коректних фраз) | 0 хибних блокувань |
| ДОДАТОК B (8 галюцинацій) | 0 пропущених |
| Усі рядки всіх секцій рулбука | 0 блокувань |

Якщо в тебе виходить інакше — різниця в регексах (найчастіше: забутий флаг `u`
або `\b` замість lookaround), а не в даних.

---

## §5. Пакет 3 — числа: тільки логування

Не блокувати. Мета — зібрати статистику, чи можна взагалі довіряти такій
перевірці, перш ніж вона почне відправляти людей до підтримки.

### 5.1. Нова функція (той самий файл)

```ts
/** Figures with a unit that do not appear in the citable text. Advisory only. */
export function findUnsupportedFigures(answer: string, grounded: { markdown: string }[]): string[]
```

Правила:

- брати з відповіді числа **з одиницею**: `%`, `$`/`usd`, `днів|дні|день|доба`, `годин|хвилин`, `робочих`;
- нормалізувати число (прибрати пробіли/коми/крапки-розділювачі тисяч) і шукати
  його в нормалізованому тексті `grounded`;
- повертати список чисел, яких не знайдено (для логу).

### 5.2. Використання

`lib/ai/support-chat.ts`, у гейті: обчислити `figures` і **додати в `logAiAnswer`**
поле `unsupportedFigures: string[]`. У результат — не додавати, рішення не
змінювати.

### 5.3. Приймання

- `findUnsupportedFigures('Комісія становить 12% від прибутку.', citable)` → `['12%']`;
- `findUnsupportedFigures('Виплата протягом 1–3 робочих днів.', citable)` → `[]`;
- `findUnsupportedFigures('Акаунт $25,000 у 1-Step коштує $199.00.', citableЗПрайсом)` → `[]`;
- жодна відповідь не блокується через числа.

---

## §6. Пакет 4 — діагностика: чому саме handoff

Зараз у UI одна картка на чотири різні причини, і адмін не бачить, яка з них
спрацювала. Без цього наступний такий баг неможливо діагностувати.

### 6.1. Аудит

`app/api/admin/support/ai-audit/route.ts`, тип `AuditItem`: додати

```ts
handoffReason: string | null
claimHits: string[]
```

- `handoffReason` — з `readSupportChatResult(row.result)?.handoffReason`;
- `claimHits` — новий рядок; для цього в `SupportChatResult` (`lib/ai/support-chat.ts`)
  додати необов'язкове поле `claimHits?: string[]` (лише `id`, без тексту) і
  заповнювати його в гейті, коли `claims.length > 0`. `readSupportChatResult`
  має його читати (`Array.isArray(record.claimHits) ? record.claimHits.filter(x => typeof x === 'string') : []`).

### 6.2. Панель

`components/admin/support-desk.tsx`, картка «AI answers · last 24h»: у рядку
заголовка поруч із `grounding` показати `handoffReason` (дрібним моноширинним),
а якщо `claimHits.length > 0` — додати їх через кому.

### 6.3. Текст для трейдера

`components/support/support-assistant.tsx` (~236). Було:

```
I could not answer this from the official rules.
```

Стало:

```
I couldn't confirm this answer against the official rules.
```

Підзаголовок лишити без змін. Причина: при блоці гейта асистент **знає**
відповідь, але не може її підтвердити — «I could not answer» вводить в оману і
саме цей текст змусив тебе відкрити цю задачу.

### 6.4. Приймання

- `npx tsc --noEmit` чисто; `npm run lint` без нових помилок;
- `npm run test:support-ui` зелений;
- новий тест у `scripts/ai-support-grounding.test.ts`: для заблокованої
  відповіді `result.claimHits` містить `trader_freeze_feature`/`freeze`.

---

## §7. Пакет 5 — фікстури і фінальна перевірка

### 7.1. Головний дефект попередньої фікстури

`scripts/fixtures/ai-grounding.cases.json` має 26 кейсів, але перевіряється лише
`mustSelect`; `mustNotSay` звіряється з відсутністю фрази в рулбуку (це правда
за побудовою), а `expectedVerdict` не читається ніде. Така фікстура не здатна
зловити жодного з багів цієї задачі.

### 7.2. Що зробити

1. Додати `expectedVerdict` зі значеннями `grounded | blocked`.
2. Переписати `scripts/ai-grounding-fixtures.test.ts` так, щоб він ганяв **повний
   гейт** для кожного кейсу: підставити `answer` і `citations` з фікстури,
   викликати `verifyCitations` + `findForbiddenClaims` і порівняти з
   `expectedVerdict`.
3. Додати кейси з ДОДАТКА A (`expectedVerdict: "grounded"`) і ДОДАТКА B
   (`"blocked"`).
4. Окремий кейс — точне повідомлення зі скріншота:

```json
{
  "id": "freeze-account-screenshot",
  "question": "Як мені заморозити акаунт?",
  "answer": "У PFT немає кнопки заморозки в інтерфейсі трейдера. Заморожений backup створюється під час оформлення замовлення як опція «+50% до fee».",
  "citations": [{ "section": 0, "quote": "The trader chat has NO Freeze, pause or close button." }],
  "mustSelect": [18],
  "expectedVerdict": "grounded"
}
```

### 7.3. Фінальні команди (усі мають бути зелені)

```bash
npx tsc --noEmit
npm run lint
npm run test:ai-grounding
npm run test:support-ui
npm run rules:build && git diff --exit-code
```

`npm run test:ai-support` у цьому середовищі **червоний і до твоїх змін**:
59 pass / 20 fail / 13 cancelled, причина — `dependencies.loadPricing is not a
function` (моки не резолвляться). Не намагайся це «полагодити» і не звітуй як
свою регресію; достатньо переконатися, що числа **не змінилися**.

### 7.4. Ручний сценарій

У `/admin` → Support → «AI answers · last 24h» після деплою перевірити, що для
заблокованих відповідей видно `handoffReason` і `claimHits`. Якщо браузера немає —
напиши це прямо, не вигадуй результат.

---

## ДОДАТОК A — 20 коректних фраз (усі мусять проходити)

```
У PFT немає кнопки заморозки в інтерфейсі трейдера.
Заморозити акаунт неможливо — такої функції немає.
Такої функції не існує.
Ні, в нас немає такого функціоналу.
Акаунт не можна заморозити самостійно.
Функція заморозки недоступна трейдеру.
Заморозити акаунт через кабінет не вийде.
Кнопки заморозки в кабінеті немає.
Ви не можете заморозити акаунт самостійно.
Frozen backup купується на checkout, заморозити акаунт вручну не можна.
Заморозка не передбачена для трейдерів.
У кабінеті відсутня функція заморозки.
Акаунт закривається автоматично після 90 днів неактивності.
Закрити акаунт самостійно не вийде — це робить адміністратор.
Закриття акаунта виконує підтримка, кнопки в кабінеті немає.
Виплата приходить протягом 1–3 робочих днів.
Виплат «на вимогу» не існує.
Fee та add-on не повертаються.
Повернення коштів не передбачено.
Кошти за fee не повертаються.
```

## ДОДАТОК B — 8 галюцинацій (усі мусять блокуватись)

```
Щоб заблокувати акаунт, використовуйте функцію «Freeze» у особистому кабінеті.   → freeze
Фріз можна активувати лише після провалу головного акаунта.                      → freeze
Виплата надходить на вимогу протягом години.                                     → on_demand_payout
Ми повернемо вам fee після breach.                                               → refund
Щоб закрити акаунт, просто не торгуйте 90 днів.                                  → inactivity_as_advice
Після breach ми розблокуємо акаунт на запит.                                     → unlock
У налаштуваннях акаунта є кнопка паузи торгівлі.                                 → pause
Закрити акаунт можна самостійно в кабінеті.                                      → self_close
```

## ДОДАТОК C — якщо щось не сходиться

- **Хочеш додати нову функцію в `ABSENT_FEATURES`** — спершу доведи, що її
  справді немає: рядок у §0 (`surfaceSection()`), або `grep` по `app components`.
  Без доказу — не додавай.
- **Якась фраза з ДОДАТКА A блокується** — додай відсутню форму заперечення в
  `NEGATION`. **Не** прибирай патерн функції і не роби виняток за конкретною
  фразою.
- **Якась фраза з ДОДАТКА B не блокується** — розшир патерн до основи
  (`/розблок/`, а не `/розблокувати/`).
- **Сумніваєшся** — вибери варіант, за якого асистент **відповідає** правильним
  негативним фактом. Кожен зайвий handoff — це тікет, який людина читає руками.
