# Промпт для воркера: калібрування відмов AI-підтримки

> Один послідовний промпт. Виконуй пакети **в порядку §2**, коміт на кожен пакет.
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
| Модель не знає фактів | **Ні.** Усі п'ять прогонів дали фактично правильну відповідь, мовою трейдера |
| Модель не генерує цитати | **Ні, генерує — але рядками.** Див. причину A |

### Три доведені причини

#### Причина A — усі цитати відкидаються парсером (головна)

Модель повертає `section` **рядком**, а `parseCitations` вимагає `typeof === 'number'`
і мовчки викидає таку цитату. Далі `verifyCitations([])` → `no_citations` → handoff.

П'ять реальних викликів провайдера (`nvidia/nemotron-3.5-lightning-30b-a3b`):

```
Як мені заморозити акаунт?      citations=["§18.3","§1","§8"]     -> розпарсено 0
How do I freeze my account?     citations=["§18.3","§1","§8"]     -> розпарсено 0
¿Cómo congelo mi cuenta?        citations=["§18.3","§1","§8"]     -> розпарсено 0
Скільки коштує акаунт 25000?    citations=["30","30"]             -> розпарсено 0
Яка комісія за виплату?         citations=["12.3","17.5","17.3"]  -> розпарсено 0
```

Сирий вихід моделі (скорочено):

```json
{"answer":"Платформа не надає кнопки …","resolved":true,"category":"GENERAL",
 "handoffReason":null,
 "citations":[{"section":"§0","quote":"The trader chat has NO Freeze, pause or close button. …"},
              {"section":"§18.3","quote":"Додається за +50% до fee; fee не повертається. …"}]}
```

`section` тут — `"§0"` і `"§18.3"`, тобто рядки. **Жодна** з п'яти відповідей не
могла пройти гейт, хоча всі п'ять були правильні. Це не «іноді» — це щоразу.

Чому проблема не видна в проді: Gemini отримує `responseSchema` з
`section: { type: Type.NUMBER }` і змушений віддати число. NVIDIA схеми не має —
лише текстовий `JSON_CONTRACT`, який просить `number`, але не примушує. Тому
баг б'є рівно там, де стоїть `NVIDIA_API_KEY` (preview/staging), і вистрелить у
проді в день, коли туди додадуть ключ.

#### Причина B — claim-guard блокує правильні відповіді (доведено)

`lib/ai/claim-guard.ts` вважає будь-яку згадку теми порушенням, а «негаціями»
вважає лише закритий список словоформ. Прогнав 23 природні коректні
формулювання — **3 заблоковано**:

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

Фільтр одночасно **занадто строгий** (карає правильне) і **занадто м'який**
(пропускає вигадане). Це друга за важливістю причина після A: коли A виправлено,
відповіді почнуть доходити до гейта — і частину з них він зріже дарма.

#### Причина C — промпт не каже, що «функції немає» — це відповідь (не доведено, але усувається дешево)

У `SUPPORT_SYSTEM_INSTRUCTIONS` три гачки для handoff і жодного явного дозволу
відповідати негативним фактом:

- рядок 128: «If the facts do not clearly answer the question, set resolved=false»;
- рядок 132: «Never perform or promise account actions: … close accounts … If asked to do so, set resolved=false and hand off»;
- рядок 143: «For questions about the product interface … hand off to a human unless the section 0 facts explicitly describe the interface».

Питання «Як мені заморозити акаунт?» читається як (а) інтерфейсне, (б) про
дію з акаунтом. Обидва гачки ведуть у handoff, а §0 («The trader chat has NO
Freeze, pause or close button») формально не «описує інтерфейс», а описує його
**відсутність**. Модель щоразу вирішує це сама — звідси нестабільність.

**Що не можна виключити без логів:** збій провайдера (`ai_unavailable`) — у UI
та сама картка. Пакет 5 робить цю різницю видимою; після нього причина кожного
handoff-а буде в аудиті.

### Відтворення (запусти до змін, щоб побачити те саме)

**A. Цитати — без мережі, детерміновано:**

```bash
cat > .probe.ts <<'EOF'
import { parseAssistantResponse } from './lib/ai/gemini'
const raw = '{"answer":"У PFT немає кнопки заморозки.","resolved":true,"category":"GENERAL","handoffReason":null,"citations":[{"section":"§18.3","quote":"The trader chat has NO Freeze, pause or close button."}]}'
console.log('string section ->', parseAssistantResponse(raw).citations.length)
console.log('numeric section ->', parseAssistantResponse(raw.replace('"§18.3"', '18')).citations.length)
EOF
npx tsx .probe.ts
rm .probe.ts
```

Очікувано: `string section -> 0`, `numeric section -> 1`.

**B. Claim-guard:**

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
   хибних спрацювань. Її поведінка має лишитись байт-у-байт. Додавати **нові**
   експорти в цей файл можна.
2. **Не роби гейт «м'яким».** Відповідь, що згадує неіснуючу функцію
   ствердно, має блокуватись. Мета — не «менше блоків», а «блоки лише там, де
   твердження справді хибне».
3. **Не послаблюй перевірку цитат.** Приведення типів (пакет 1) — єдина зміна,
   дозволена навколо цитат. Цитата далі мусить бути дослівним підрядком секції.
4. **Не видаляй і не послаблюй існуючі тести.** Якщо тест падає — або код
   неправильний, або тест описував стару поведінку; у другому випадку
   перепиши тест і **поясни це в коміті**.
5. **Без нових npm-залежностей, без змін у `prisma/schema.prisma`.**
6. **Один пакет = один коміт.** Повідомлення коміту: `pkg N: <що зроблено>`.
7. **Не чіпай** `.gitignore`, `CLAUDE.md`, `android/`, `support-app/` — там чужі
   зміни.
8. Якщо після пакета `npm run test:ai-grounding` стає червоним — пакет не
   завершений.
9. `package.json` можна правити **лише** щоб додати новий тестовий файл у
   список `test:ai-grounding` (пакет 6). Нічого іншого там не змінюй.

### Файли, які ти будеш читати

| Файл | Навіщо |
|---|---|
| `lib/ai/gemini.ts` (~152–163) | `parseCitations` — місце причини A |
| `lib/ai/grounding.ts` | `normalizeForMatch`, `verifyCitations`, новий `coerceSectionNumber` |
| `lib/ai/claim-guard.ts` | патерни і негації, які замінюєш |
| `lib/ai/support-chat.ts` (~354–450) | `socialReply`, `readCitations`, місце виклику гейта |
| `lib/ai/pft-knowledge.ts` (~119–143) | системні інструкції |
| `components/support/support-assistant.tsx` (~236) | текст картки handoff |
| `app/api/admin/support/ai-audit/route.ts` | аудит |
| `scripts/ai-grounding.test.ts`, `scripts/ai-claim-guard.test.ts`, `scripts/ai-prompt-grounding.test.ts` | тести |
| `lib/support/live.ts` (~40) | зразок того, як у проєкті роблять локалізовані підписи |

---

## §2. Порядок пакетів

| Пакет | Що | Залежить від | § |
|---|---|---|---|
| 1 | Цитати: `section` рядком → числом | — | §3 |
| 2 | Промпт: відсутність — це відповідь | — | §4 |
| 3 | Заміна claim-guard на інваріант «неіснуюча функція» | — | §5 |
| 4 | Числа: тільки логування (без блокування) | 3 | §6 |
| 5 | Діагностика: причина handoff-а в аудиті + честний текст у UI | 2, 3 | §7 |
| 6 | Мова відповіді: canned-відповіді й картка handoff | 5 | §8 |
| 7 | Фікстури + фінальна перевірка | 1–6 | §9 |

**Пакет 1 перший і обов'язковий.** Без нього решта не має ефекту: гейт усе одно
відкидатиме кожну відповідь через `no_citations`.

---

## §3. Пакет 1 — цитати: `section` приходить рядком

**Файли:** `lib/ai/grounding.ts` (новий експорт), `lib/ai/gemini.ts`
(`parseCitations`), `lib/ai/support-chat.ts` (`readCitations`).

### 3.1. Новий експорт у `lib/ai/grounding.ts`

Додати поряд з `normalizeForMatch`, **не змінюючи** `verifyCitations`:

```ts
/** Sections are integers; a model may still write "§18.3", "30" or 18.3. */
const MAX_SECTION_NUMBER = 999

export function coerceSectionNumber(value: unknown): number | null {
  let raw: number
  if (typeof value === 'number') {
    raw = value
  } else if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^[§#]\s*/, '')
    if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null
    raw = Number(cleaned)
  } else {
    return null
  }
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_SECTION_NUMBER) return null
  return Math.trunc(raw)
}
```

### 3.2. `parseCitations` у `lib/ai/gemini.ts`

Було:

```ts
if (typeof record.section !== 'number' || typeof record.quote !== 'string' || record.quote.length === 0) continue
citations.push({ section: record.section, quote: record.quote })
```

Стало:

```ts
const section = coerceSectionNumber(record.section)
if (section === null || typeof record.quote !== 'string' || record.quote.length === 0) continue
citations.push({ section, quote: record.quote })
```

Не забудь `import { coerceSectionNumber } from './grounding'`.

### 3.3. `readCitations` у `lib/ai/support-chat.ts`

Той самий `coerceSectionNumber` замість `typeof record.section === 'number'` —
щоб старі збережені результати читались так само.

### 3.4. Чому `Math.trunc`, а не відмова

`§18.3` — підрозділ §18. Після зведення до `18` цитата все одно мусить бути
дослівним підрядком markdown-у секції 18. Тобто перевірка може стати **тільки
строгішою**, а не м'якшою: вигадана цитата далі падає з `quote_not_found`, а
цитата з §25.1, коли §25 не в `citable`, падає з `unknown_section`. Відмова
(`null`) навпаки повернула б нас до `no_citations`, тобто до того самого handoff-а.

### 3.5. Приймання пакета 1

`scripts/ai-grounding.test.ts`:

- `parseAssistantResponse` на payload з `"section":"§18.3"` → `citations[0].section === 18`;
- `"section":"§0"` → `0`; `"section":"30"` → `30`; `"section":"12.3"` → `12`;
- `"section":"abc"`, `"section":null`, `"section":"§"` → цитата відкинута (0 citations);
- `coerceSectionNumber(-1)` → `null`, `coerceSectionNumber(1e6)` → `null`.

`scripts/ai-support-grounding.test.ts` (або `ai-grounding.test.ts`):

- наскрізний тест: сирий JSON моделі з `"§0"` + `"§18.3"` (реальні цитати з §0)
  після `parseAssistantResponse` + `verifyCitations(…, citableSections(...))`
  дає `ok: true`.

**Еталон** (перевірено перед написанням промпта на реальному виводі моделі):

```
§0    -> 0
§18.3 -> 18
verdict ok = true
```

- `git diff lib/ai/grounding.ts` показує лише доданий `coerceSectionNumber`;
  тіло `verifyCitations` не змінене.
- `npx tsc --noEmit` чисто, `npm run test:ai-grounding` зелений.

---

## §4. Пакет 2 — промпт: відсутність це відповідь

**Файл:** `lib/ai/pft-knowledge.ts`, масив `SUPPORT_SYSTEM_INSTRUCTIONS`.

> Номери рядків нижче — орієнтир станом на коміт `5434ce5`. Шукай елемент **за
> текстом**, а не за номером: після першої вставки номери зсуваються.

### 4.1. Замінити правило про інтерфейсні питання

Було:

```
'For questions about the product interface ("where is X?", "how do I use Y?"): hand off to a human unless the section 0 facts of the prompt explicitly describe the interface.',
```

Стало (рівно один елемент масиву):

```
'Interface questions ("where is X?", "how do I use Y?"): answer from §0 whenever §0 mentions the element — including when §0 says the element does NOT exist. Hand off only when §0 says nothing about that element at all.',
```

### 4.2. Додати правило про негативний факт

Одразу **після** рядка 131 (`'Do not hand off a question that the facts can answer…'`) вставити:

```
'A documented absence is an answer. When §0 or a rulebook section states that a feature does not exist, that statement IS the answer: say plainly that it does not exist, cite that sentence, and set resolved=true. Never hand off a "does X exist?" or "how do I X?" question that the facts answer with "no".',
```

### 4.3. Звузити правило про дії з акаунтом

Було:

```
'Never perform or promise account actions: do not void profit, close accounts, change balances, approve payouts or lift breaches. If asked to do so, set resolved=false and hand off.',
```

Стало:

```
'Never perform or promise account actions: do not void profit, close accounts, change balances, approve payouts or lift breaches. This covers requests to act on a specific account; it does not cover "how does X work" or "does X exist" questions. If asked to act, set resolved=false and hand off.',
```

### 4.4. Явно перелічити цитовані номери

У рядок, що починається з `'Citations: when you state a factual sentence…'`, додати в кінець речення:

```
' Every section number you may cite appears in this request: §0 (platform facts), §30 (pricing) and the rulebook sections listed above. Never cite a section that is not in this request; cite §0 for anything about the interface.',
```

Формулювання навмисно привʼязане до «того, що є в цьому запиті», а не до
діапазону 1–24: `selectSections` дає 3–5 секцій, і цитата з невибраної секції
впаде з `unknown_section` → handoff.

### 4.5. Два приклади (few-shot)

Додати **в кінець** `SUPPORT_SYSTEM_INSTRUCTIONS` двома елементами:

```
'Example — Q: "Як мені заморозити акаунт?" → answer: "У PFT немає кнопки заморозки: заморозити акаунт самостійно неможливо." resolved=true, citations=[{section: 0, quote: "The trader chat has NO Freeze, pause or close button."}].',
'Example — Q: "Скільки коштує акаунт 25000?" → answer lists every plan variant for that size with its base fee, resolved=true, citations point at §30. A price answer is never a handoff.',
```

**Заборонено:** додавати в промпт нові факти про продукт. Приклади — лише
перефразування того, що вже є в §0/§30/рулбуку.

### 4.6. Приймання пакета 2

- `npx tsc --noEmit` чисто.
- У `scripts/ai-prompt-grounding.test.ts` додати 2 тести:
  - промпт містить підрядок `'A documented absence is an answer'`;
  - промпт **не** містить `'hand off to a human unless the section 0 facts'`.
- `npm run test:ai-grounding` зелений.

---

## §5. Пакет 3 — claim-guard: один інваріант замість списку тем

**Файл:** `lib/ai/claim-guard.ts` — переписати `CLAIM_RULES` і `findForbiddenClaims`.

### 5.1. Інваріант

> Якщо речення згадує функцію, якої в продукті **немає**, воно мусить бути
> заперечним. Ствердна згадка такої функції — вигадка, за визначенням.

Це прибирає потребу вгадувати «чи це інструкція»: правильна відповідь про
відсутність завжди містить заперечення, хибна — ніколи.

### 5.2. Дані

```ts
/** Features the product does not have. Every entry must be provable from §0. */
export const ABSENT_FEATURES: { id: string; patterns: RegExp[] }[] = [
  { id: 'freeze', patterns: [/замороз/i, /заморож/i, /фріз/i, /freeze/i] },
  { id: 'pause', patterns: [/пауз/i, /призупин/i, /(?<![a-z])pause(?![a-z])/i] },
  { id: 'self_close', patterns: [/закрит\p{L}*\s+акаунт/iu, /блокуван\p{L}*\s+акаунт/iu, /terminat\p{L}*/i] },
  { id: 'on_demand_payout', patterns: [/on-?demand/i, /на\s+вимогу/i, /миттєв\p{L}*\s+виплат/iu] },
  { id: 'refund', patterns: [/поверн\p{L}*[^.]{0,40}(fee|кошт|грош)/iu, /refund\s+(fee|add-?on)/i] },
  { id: 'unlock', patterns: [/розблок\p{L}*/iu, /віднов\p{L}*\s+акаунт/iu] },
]
```

Патерни — **основи**, не словоформи. Саме через словоформи попередня версія
пропускала «розблокуємо» і «на вимогу».

`freeze` містить **два** корені — `/замороз/i` і `/заморож/i`: в українській
відбувається чергування з/ж, тому «заморозки» і «заморожування» це різні корені.
Без другого патерна «Заморожування акаунта доступне в кабінеті» проходить як
правда.

`refund` навмисно дозволяє до 40 символів між дієсловом і обʼєктом: інакше
«Ми повернемо вам fee» не ловиться.

> **Пастка, на якій легко втратити годину.** У JS `\b` не працює з кирилицею
> (`\w` — це лише ASCII), а `\p{L}` діє **тільки** з флагом `u`. Тому:
> `/\bне\s+/` ніколи не зматчить «не можна», а `/розблок\p{L}*/i` без `u`
> шукає буквально «розблокp{L}». Кожен патерн із `\p{L}` мусить мати `u`,
> а межі слова для кирилиці — через `(?<!\p{L})` / `(?!\p{L})`.

### 5.3. Заперечення

```ts
const NEGATION: RegExp[] = [
  /немає/i, /(?<!\p{L})нема(?!\p{L})/iu, /відсутн/i, /неможлив/i, /недоступн/i, /жодн/i,
  // будь-яке «не + дієслово» — це заперечення
  /(?<!\p{L})не\s+\p{L}{0,3}(мож|вий|прац|підтрим|передбач|доступ|існу|має|мають|дав|дає|дають|буде|будуть|став|роб|нада|пропон)/iu,
  /(?<![a-z])not(?![a-z])/i, /(?<![a-z])no(?![a-z])/i, /(?<![a-z])never(?![a-z])/i,
  /(?<![a-z])none(?![a-z])/i, /isn'?t/i, /doesn'?t/i, /don'?t/i,
]
```

`\p{L}{0,3}` перед альтернацією — це навмисно: воно ловить «не **на**дає» (2 літери
+ `дає`) і «не **пере**дбачено», не вимагаючи перелічувати всі префікси.

**Не додавай** голий `/\bне\b/` (він і не спрацює через кирилицю) і не додавай у
список дієслово `торг`: тоді «не торгуйте» стане запереченням і пропустить
пораду простоювати.

### 5.4. Хто виконує дію

Два винятки — обидва **лише** для своєї функції:

```ts
/** Closing an account is done by staff or by the system — that is the truth. */
const NOT_SELF_SERVICE = [/адміністратор/i, /підтримк/i, /автоматичн/i, /виконує/i]

/** The frozen backup add-on is a real product; naming it is not a fabrication. */
const FROZEN_BACKUP = [/(frozen|фріз|заморожен\p{L}*)\s*(backup|бек-?ап)/iu, /frozen\s+backup/i]
```

- `NOT_SELF_SERVICE` — тільки для `self_close`. Без нього «Закриття акаунта
  виконує підтримка.» блокувалось би, хоча це правда з §0.
- `FROZEN_BACKUP` — тільки для `freeze`. Без нього «Заморожений backup можна
  купити під час checkout.» блокувалось би, хоча це теж правда з §18.

### 5.5. Функція

```ts
/** Advice to idle the account until it is closed — the rulebook says the opposite. */
const INACTIVITY_ADVICE =
  /(подбайте|достатньо|просто|варто)(?![а-яіїєґ])[^.]{0,60}(неактивн|не\s+торгуй|не\s+входь|не\s+заходь)/iu

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
      if (feature.id === 'freeze' && FROZEN_BACKUP.some((pattern) => pattern.test(sentence))) continue
      const key = `${feature.id}:${sentence.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ id: feature.id, reason: `The product has no ${feature.id}; an affirmative mention is a fabrication.`, match: sentence.slice(0, 120) })
    }
  }
  return hits
}
```

`INACTIVITY_ADVICE` навмисно **без** `\b` після групи: `\b` після кириличного
слова не спрацьовує (див. пастку вище), і правило мовчки не діяло б. Замість
`\b` — `(?![а-яіїєґ])`.

Порядок перевірок — частина контракту, не стиль: спершу «дослівна цитата»
(вона вже перевірена `verifyCitations`), потім заперечення, потім порада
простоювати, і лише потім згадка функції. Перестав — отримаєш або хибні
блокування, або пропущені галюцинації.

### 5.6. Приймання пакета 3

`scripts/ai-claim-guard.test.ts`:

- **усі 23** фрази з ДОДАТКА A → `0` хітів (це головний тест пакета);
- **усі 9** фраз із ДОДАТКА B → `> 0` хітів, з правильним `id`;
- зберегти наявний тест «дослівна цитата рулбука не карається»;
- додати тест: `findForbiddenClaims('Щоб закрити акаунт, просто не торгуйте 90 днів.')` → хіт
  `inactivity_as_advice` (доводить, що «не торгуйте» не стало запереченням).

`npm run test:ai-grounding` зелений.

**Еталон, якого треба досягти** (ця логіка прогнана перед написанням промпта):

| Перевірка | Результат |
|---|---|
| ДОДАТОК A (23 коректні фрази) | 0 хибних блокувань |
| ДОДАТОК B (9 галюцинацій) | 0 пропущених, `id` збігається |
| Усі рядки всіх секцій рулбука | 0 блокувань |

Якщо в тебе виходить інакше — різниця в регексах (найчастіше: забутий флаг `u`
або `\b` замість lookaround), а не в даних.

---

## §6. Пакет 4 — числа: тільки логування

Не блокувати. Мета — зібрати статистику, чи можна взагалі довіряти такій
перевірці, перш ніж вона почне відправляти людей до підтримки.

### 6.1. Нова функція (той самий файл)

```ts
/** Figures with a unit that do not appear in the citable text. Advisory only. */
export function findUnsupportedFigures(answer: string, grounded: { markdown: string }[]): string[]
```

Правила:

- брати з відповіді числа **з одиницею**: `%`, `$`/`usd`, `днів|дні|день|доба`, `годин|хвилин`, `робочих`;
- нормалізувати число (прибрати пробіли/коми/крапки-розділювачі тисяч) і шукати
  його в нормалізованому тексті `grounded`;
- повертати список чисел, яких не знайдено (для логу).

### 6.2. Використання

`lib/ai/support-chat.ts`, у гейті: обчислити `figures` і **додати в `logAiAnswer`**
поле `unsupportedFigures: string[]`. У результат — не додавати, рішення не
змінювати.

### 6.3. Приймання

- `findUnsupportedFigures('Комісія становить 12% від прибутку.', citable)` → `['12%']`;
- `findUnsupportedFigures('Виплата протягом 1–3 робочих днів.', citable)` → `[]`;
- `findUnsupportedFigures('Акаунт $25,000 у 1-Step коштує $199.00.', citableЗПрайсом)` → `[]`;
- жодна відповідь не блокується через числа.

---

## §7. Пакет 5 — діагностика: чому саме handoff

Зараз у UI одна картка на чотири різні причини, і адмін не бачить, яка з них
спрацювала. Без цього наступний такий баг неможливо діагностувати.

### 7.1. Аудит

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

### 7.2. Панель

`components/admin/support-desk.tsx`, картка «AI answers · last 24h»: у рядку
заголовка поруч із `grounding` показати `handoffReason` (дрібним моноширинним),
а якщо `claimHits.length > 0` — додати їх через кому.

### 7.3. Текст для трейдера

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

### 7.4. Приймання

- `npx tsc --noEmit` чисто; `npm run lint` без нових помилок;
- `npm run test:support-ui` зелений;
- новий тест у `scripts/ai-support-grounding.test.ts`: для заблокованої
  відповіді `result.claimHits` містить `freeze`.

---

## §8. Пакет 6 — мова відповіді

### 8.1. Що перевірено (не роби «перекладач»)

Гіпотеза «модель працює лише з англійською» — **хибна**. Той самий запит трьома
мовами дав три правильні відповіді мовою запиту:

```
Q: Як мені заморозити акаунт?   -> «Платформа не надає кнопки «Заморозування» у чаті трейдера…»
Q: How do I freeze my account?  -> «PFT accounts cannot be manually frozen or closed by the trader…»
Q: ¿Cómo congelo mi cuenta?     -> «No hay botón de congelar en el chat del trader…»
```

Промпт уже містить правило мови (рядок 123: «Always answer in the language of
the trader's latest message»). Тому **шару перекладу не потрібно**, і додавати
його заборонено: він додасть затримку, втрату нюансів і другу точку відмови.

Англійський текст, який ти бачив на скріншоті, — це **не модель**. Це
`socialReply()` у `lib/ai/support-chat.ts`, який вибирає мову за наявністю
будь-якої кирилиці. Латиниця без кирилиці → англійська, навіть якщо це
іспанське «hola».

Що справді треба виправити: (а) canned-відповіді мають бути мовою трейдера, а не
«кирилиця/не кирилиця»; (б) картка handoff — теж.

**Поза скоупом, і це свідомо:** ретрив-аліаси для нових мов. `selectSections`
індексує uk/ru/en, бо там пише база трейдерів. Якщо питання іншою мовою не
влучає в жоден аліас — це чесний `no_matching_rules`, а не баг. Якщо влучає
(наприклад, у питані є слово `payout`) — відповідь буде мовою трейдера, а
цитати лишаться мовою рулбука, як і вимагає контракт.

### 8.2. Новий файл `lib/ai/language.ts`

Тільки чисті рядкові операції — жодних імпортів із Node або БД, бо файл
використовується і в клієнтському компоненті.

```ts
export type ReplyLanguage = 'uk' | 'ru' | 'en' | 'es'

const CYRILLIC = /[\u0400-\u04FF]/
const UKRAINIAN = /[іїєґ]|(?<!\p{L})(мені|мене|що|як|чому|дякую|будь|ласка|виплата|привіт|добрий|доброго|зрозуміло|добре)(?!\p{L})/iu
const SPANISH = /[ñ¿¡]|(?<!\p{L})(hola|buenas|gracias|cuenta|puedo|c[oó]mo|d[oó]nde|cu[aá]nto|quiero|necesito|ayuda|vale|perfecto|entendido)(?!\p{L})/iu

/** Language of the trader's message. Unknown scripts fall back to English. */
export function detectLanguage(text: string): ReplyLanguage {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'en'
  if (CYRILLIC.test(trimmed)) return UKRAINIAN.test(trimmed) ? 'uk' : 'ru'
  if (SPANISH.test(trimmed)) return 'es'
  return 'en'
}
```

`ru` — це не «російська за замовчуванням», а «кирилиця без українських
маркерів»; для canned-відповіді цього достатньо. Слова-маркери навмисно
унікальні для мови (`мені`, `що`, `дякую`) — не бери `акаунт`, бо так само
пишуть і російськомовні, і тоді російське питання отримає українську картку.

### 8.3. Перенести `socialReply` у той самий файл

Перенести `SMALL_TALK` і `socialReply` з `lib/ai/support-chat.ts` у
`lib/ai/language.ts`, зробивши `socialReply` **експортованим** (щоб його можна
було тестувати без БД). `support-chat.ts` імпортує його звідти.

Мову вибирати через явну таблицю токенів, а не через `detectLanguage`:

```ts
const GREETINGS: { lang: ReplyLanguage; pattern: RegExp }[] = [
  { lang: 'uk', pattern: /^(привіт|вітаю|добрий день|доброго дня|добрий вечір|дякую|спасибі|окей|добре|зрозуміло|ок)$/i },
  { lang: 'ru', pattern: /^(привет|здравствуйте|добрый день|добрый вечер|спасибо|понятно|хорошо|ок)$/i },
  { lang: 'en', pattern: /^(hello|hi|hey|thanks|thank you|ok|okay|got it)$/i },
  { lang: 'es', pattern: /^(hola|buenas|gracias|vale|perfecto|entendido)$/i },
]

const SOCIAL_REPLIES: Record<ReplyLanguage, string> = {
  uk: 'Дякую за повідомлення! Опишіть, будь ласка, вашу ситуацію — я допоможу з правилами PFT, виплатами, KYC та акаунтами.',
  ru: 'Спасибо за сообщение! Опишите, пожалуйста, вашу ситуацию — я помогу с правилами PFT, выплатами, KYC и аккаунтами.',
  en: 'Thanks for your message! Please describe your situation — I can help with PFT rules, payouts, KYC and accounts.',
  es: 'Gracias por tu mensaje. Describe tu situación y te ayudaré con las reglas de PFT, los pagos, el KYC y las cuentas.',
}

export function socialReply(message: string): string | null {
  const trimmed = message.trim()
  if (trimmed.length === 0 || trimmed.length > 40) return null
  const match = GREETINGS.find((entry) => entry.pattern.test(trimmed))
  return match ? SOCIAL_REPLIES[match.lang] : null
}
```

Порядок у `GREETINGS` важливий: `ок` є в кількох мовах, і перший збіг виграє —
українська стоїть першою (найбільша аудиторія), англійська йде **перед**
іспанською, щоб латинське `ok` лишалось англійським, а не іспанським.

### 8.4. Локалізувати картку handoff

`components/support/support-assistant.tsx`. Додати в `lib/ai/language.ts`:

```ts
export function handoffLabels(lang: ReplyLanguage) {
  const LABELS = {
    uk: { title: 'Я не зміг підтвердити цю відповідь за офіційними правилами.', question: 'Передати запит живому агенту підтримки?', yes: 'Так, передати агенту', no: 'Ні' },
    ru: { title: 'Я не смог подтвердить этот ответ по официальным правилам.', question: 'Передать запрос живому агенту поддержки?', yes: 'Да, передать агенту', no: 'Нет' },
    en: { title: "I couldn't confirm this answer against the official rules.", question: 'Pass this request to a human support agent?', yes: 'Yes, pass to agent', no: 'No' },
    es: { title: 'No pude confirmar esta respuesta con las reglas oficiales.', question: '¿Pasar esta consulta a un agente humano?', yes: 'Sí, pasar al agente', no: 'No' },
  }
  return LABELS[lang]
}
```

У компоненті:

```ts
const lang = detectLanguage([...turns].reverse().find((turn) => turn.role === 'user')?.content ?? '')
const labels = handoffLabels(lang)
```

і замінити чотири hardcoded рядки на `labels.title`, `labels.question`,
`labels.yes`, `labels.no`. Заголовок картки — це той самий текст, що й у §7.3
(англійська версія має збігатися байт-у-байт).

Якщо в розмові ще немає жодного повідомлення трейдера — `detectLanguage('')`
дає `'en'`, тобто поточна поведінка.

### 8.5. Приймання пакета 6

Новий файл `scripts/ai-language.test.ts`, додати його в список
`test:ai-grounding` у `package.json`:

- `detectLanguage('Привіт')` → `'uk'`, `'Привет'` → `'ru'`, `'Hola'` → `'es'`,
  `'Hello'` → `'en'`, `'12345'` → `'en'`, `''` → `'en'`;
- `detectLanguage('Як мені заморозити акаунт?')` → `'uk'`;
- `detectLanguage('Сколько стоит акаунт?')` → `'ru'` (маркери не мають ловити
  російську через слово «акаунт»);
- `socialReply('Привіт')` містить `'Дякую'`; `socialReply('Привет')` містить `'Спасибо'`;
  `socialReply('hola')` містить `'Gracias'`; `socialReply('hello')` містить `'Thanks'`;
- **регресійний тест на скріншот:** `socialReply('Привіт')` **не** містить
  `'Thanks for your message'` — саме цей рядок побачив трейдер;
- `handoffLabels('uk').title` не містить латиниці.

- `npx tsc --noEmit` чисто; `npm run test:support-ui` зелений; `npm run lint` без нових помилок.

---

## §9. Пакет 7 — фікстури і фінальна перевірка

### 9.1. Головний дефект попередньої фікстури

`scripts/fixtures/ai-grounding.cases.json` має 26 кейсів, але перевіряється лише
`mustSelect`; `mustNotSay` звіряється з відсутністю фрази в рулбуку (це правда
за побудовою), а `expectedVerdict` не читається ніде. Така фікстура не здатна
зловити жодного з багів цієї задачі.

### 9.2. Що зробити

1. Додати `expectedVerdict` зі значеннями `grounded | blocked`.
2. Переписати `scripts/ai-grounding-fixtures.test.ts` так, щоб він ганяв **повний
   гейт** для кожного кейсу: підставити `answer` і `citations` з фікстури,
   викликати `coerceSectionNumber` + `verifyCitations` + `findForbiddenClaims` і
   порівняти з `expectedVerdict`.
3. Додати кейси з ДОДАТКА A (`expectedVerdict: "grounded"`) і ДОДАТКА B
   (`"blocked"`).
4. Окремий кейс — точне повідомлення зі скріншота, з цитатами **як їх віддає
   модель** (рядками):

```json
{
  "id": "freeze-account-screenshot",
  "question": "Як мені заморозити акаунт?",
  "answer": "У PFT немає кнопки заморозки в інтерфейсі трейдера. Заморожений backup створюється під час оформлення замовлення як опція «+50% до fee».",
  "citations": [
    { "section": "§0", "quote": "The trader chat has NO Freeze, pause or close button." },
    { "section": "§18.3", "quote": "Додається за +50% до fee; fee не повертається." }
  ],
  "mustSelect": [18],
  "expectedVerdict": "grounded"
}
```

Цей кейс — головний: він падає на коді до пакета 1 і проходить після.

### 9.3. Фінальні команди (усі мають бути зелені)

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

### 9.4. Ручний сценарій

У `/admin` → Support → «AI answers · last 24h» після деплою перевірити, що для
заблокованих відповідей видно `handoffReason` і `claimHits`. Якщо браузера немає —
напиши це прямо, не вигадуй результат.

---

## ДОДАТОК A — 23 коректні фрази (усі мусять проходити)

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
Платформа не надає функції заморозки.
Заморожений backup можна купити під час checkout.
У кабінеті немає жодної кнопки для заморожування акаунта.
```

Останні три додані навмисно: вони перевіряють `не надає` (негація через
префікс), виняток `FROZEN_BACKUP` і корінь `/заморож/`.

## ДОДАТОК B — 9 галюцинацій (усі мусять блокуватись)

```
Щоб заблокувати акаунт, використовуйте функцію «Freeze» у особистому кабінеті.   → freeze
Фріз можна активувати лише після провалу головного акаунта.                      → freeze
Заморожування акаунта доступне в кабінеті трейдера.                              → freeze
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
- **Правильна фраза блокується через реальний продукт** (як `frozen backup`) —
  додай виняток за зразком `FROZEN_BACKUP`, привʼязаний до **цієї** функції.
  Виняток не має права поширюватись на інші функції.
- **Тест на цитати падає після пакета 1** — перевір, що `coerceSectionNumber`
  повертає `null` для всього, що не є числом або числовим рядком. Не «розширюй»
  його до `parseFloat`, інакше `"§"` стане `NaN`.
- **Сумніваєшся** — вибери варіант, за якого асистент **відповідає** правильним
  негативним фактом. Кожен зайвий handoff — це тікет, який людина читає руками.
