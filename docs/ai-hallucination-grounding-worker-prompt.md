# Промпт для виконавця: прибрати галюцинації в AI-підтримці PFT

> Це єдиний документ, за яким ти працюєш. Він самодостатній: не шукай додаткових
> інструкцій, не вигадуй фіч поза ним і не «покращуй» сусідній код.
> Якщо щось у документі суперечить коду — пріоритет такий: **1) цей файл,
> 2) `CLAUDE.md`, 3) існуючий код**. Суперечність зафіксуй у PR-описі, не вирішуй мовчки.

---

## 0. Контекст

**Що сталося.** Трейдер запитав, як заблокувати акаунт. Асистент відповів (дослівно):

> «Щоб заблокувати акаунт, використовуйте функцію «Freeze» у особистому кабінеті.
> Це тимчасово зупиняє торгівлю, але обов'язково зверніть увагу на умови: фріз
> зберігається, поки основний акаунт активний. Якщо основний акаунт пройшов успішно,
> фріз розгортається без повернення коштів. Фріз можна активувати лише після провалу
> головного акаунта. Якщо ви хочете закрити акаунт без повернення коштів, подбайте про
> те, щоб акаунт був неактивний більше 90 календарних днів — це дозволяє системі
> закрити акаунт без повернення коштів.»

**Функції «Freeze» для трейдера не існує.** Відповідь — суцільна вигадка, зібрана з
двох реальних фактів, і в ній є пряма шкода: трейдеру радять «подбати», щоб акаунт
простоював 90 днів, тобто радять навмисно підставитись під кару.

**Звідки взялися складники (перевірено по `lib/rules/rulebook.generated.json`):**

| Фраза у відповіді | Реальне джерело | Що зробила модель |
|---|---|---|
| «функція «Freeze» у особистому кабінеті» | §18.3 «Frozen backup add-on» — **опція, яку купують на checkout**, не кнопка | перетворила куплену опцію на UI-функцію |
| «фріз зберігається, поки основний акаунт активний» | §18.3, дослівно правильно | скопіювала |
| «фріз розгортається без повернення коштів» | §18.3 «backup expires без refund» | «expires» → «розгортається» (хибний переклад) |
| «Фріз можна активувати лише після провалу» | §18.3, правильно | і суперечить власному попередньому реченню |
| «подбайте, щоб акаунт був неактивний 90 днів» | §8 «90 днів без торгівлі → може бути закритий без refund» | перетворила **наслідок** на **пораду**; викинула «перед закриттям має бути мінімум одне нагадування» |

**Стек і шлях запиту:**

```
components/support/support-assistant.tsx        (UI трейдера, EN)
  → lib/ai/assistant-client.ts                  requestAssistant()
  → app/api/support/ai/chat/route.ts            POST, валідація лише форми запиту
  → lib/ai/support-chat.ts                      handleSupportChat() → handleSupportChatOnce()
  → lib/ai/pft-knowledge.ts                     buildPftKnowledge() + SUPPORT_SYSTEM_INSTRUCTIONS
  → lib/ai/provider.ts                          resolveProvider() → gemini | nvidia
  → lib/ai/gemini.ts | lib/ai/nvidia.ts         temperature 0.2, JSON-схема
  → lib/ai/gemini.ts parseAssistantResponse()   валідація ЛИШЕ структури JSON
```

**П'ять кореневих причин (усе інше — похідні):**

1. **Два джерела правди.** `lib/ai/pft-knowledge.ts` — рукописний англійський конспект
   (~15 200 символів, ~40 булітів). Офіційний рулбук — `docs/PFT-rulebook-v1.md` →
   `lib/rules/rulebook.generated.json` (25 секцій, 43 617 символів, **українською**,
   `sourceHash`). Рулбук у AI-шляху **не використовується взагалі** — тільки у
   `components/support/rules-browser.tsx` (вкладка «Правила»). Будь-яке оновлення
   рулбука робить асистента брехуном, і ніхто цього не помітить.
2. **Мова відповіді ≠ мова джерела.** Факти англійською, відповідь українською →
   модель перекладає під час генерації. Саме тут народжуються «фріз» і «розгортається».
3. **Ніщо не перевіряє зміст.** У системному промпті ~20 імперативів «не вигадуй», але
   жодної механічної перевірки. `readSupportChatResult()` перевіряє лише форму JSON.
   Відповідь із вигаданою фічею проходить як `resolved: true` і йде трейдеру.
4. **Модель не знає про відсутність.** Усі факти — ствердні. «Кнопки Freeze не існує»
   ніде не написано, тому «у особистому кабінеті» для моделі неспростовне.
5. **Стиснення змушує домальовувати.** 40 булітів замість 25 секцій. Питання, що
   впало між булітами («як закрити акаунт?»), зшивається з найближчих булітів у
   правдоподібну, але вигадану процедуру.

**Шоста проблема — не технічна, а операційна:** відповіді ніде не зберігаються. Власник
не може подивитись, що асистент насправді казав, і не може оцінити масштаб. Тому
останній пакет — видимість.

**Перед першим рядком коду зроби обов'язково:**

1. Прочитай `AGENTS.md` і `CLAUDE.md` у корені.
2. Прочитай `node_modules/next/dist/docs/` — у цій версії Next.js є breaking changes
   відносно твоїх тренувальних даних. Не пиши код «по пам'яті».
3. Прочитай `docs/PFT-rulebook-v1.md` **повністю**. Це джерело правди, з яким ти
   працюєш. Не переписуй його і не редагуй.
4. Прочитай `lib/ai/pft-knowledge.ts`, `lib/ai/support-chat.ts`, `lib/ai/gemini.ts`,
   `lib/ai/nvidia.ts`, `lib/ai/assistant-client.ts` — усі п'ять цілком.

---

## 1. Жорсткі правила (порушення = робота не приймається)

1. **Не змінюй `prisma/schema.prisma`.** Міграцій у цьому завданні немає.
2. **Не додавай npm-залежностей.** Ні стемерів, ні `fuse.js`, ні `zod`, ні embeddings-клієнтів.
3. **Не чіпай `docs/PFT-rulebook-v1.md`.** Це джерело правди. Ти читаєш його, не редагуєш.
4. **Не змінюй `lib/rules/*`** (крім нового `lib/rules/rulebook.ts`), `lib/finance`,
   `lib/payouts`, `lib/trading`, `lib/support/service.ts`.
5. **Не ламай наявні контракти.** Нові поля в JSON додавати можна. Видаляти,
   перейменовувати або змінювати типи наявних — ні. `answer`, `resolved`, `category`,
   `handoffReason`, `suggestedHandoff`, `suggestedCategory` лишаються як є.
6. **Не запускай** `prisma db push`, `db:migrate`, `db:seed`, деплой, `git push`.
7. **Не запускай `next build` локально.** У цьому середовищі він падає на
   `node-safe-delete-shim` (`SAFE_DELETE_BULK_CONFIRM_REQUIRED` на `.next/trace-build`) —
   це не твоя проблема і не твоя помилка. Перевіряй через `tsc --noEmit` + `lint` + тести.
8. **Не «виправляй» `npm run test:ai-support`.** Він червоний у цьому середовищі **до**
   твоїх змін: `mock.module` для `../lib/ai/support-pricing` не резолвиться
   (`dependencies.loadPricing is not a function`). Перевіряється через `git archive` у
   чистому каталозі — там ті самі цифри. Зафіксуй фактичні цифри до і після, не намагайся
   їх «позеленіти».
9. **Нуль продуктових фактів у `SUPPORT_SYSTEM_INSTRUCTIONS`.** Після пакета 3 у
   інструкціях не має бути жодної цифри, відсотка, суми чи назви фічі. Факти живуть
   тільки в grounded-секціях. Це перевіряється тестом.
10. **Кожен пакет = окремий коміт.** Після кожного: `npx tsc --noEmit` + `npm run lint`
    (0 errors) + тести пакета зелені. Не переходь далі з червоним.
11. **Мінімум коду.** Якщо 200 рядків зводяться до 50 — зводь. Без «на майбутнє».
12. **Коментарі — англійською**, як у решті коду. UI-рядки — мовою файлу, який редагуєш.

---

## 2. Порядок робіт

Пакети виконуються **строго по порядку**. Кожен наступний спирається на попередній.

| # | Пакет | Суть | Залежить від |
|---|---|---|---|
| 0 | `lib/rules/rulebook.ts` | типізований доступ до згенерованого рулбука | — |
| 1 | `lib/ai/grounding.ts` | відбір секцій + механічна перевірка цитат | 0 |
| 2 | `lib/ai/claim-guard.ts` | детермінований ловець вигаданих фіч | — |
| 3 | Промпт + знання | ground-промпт замість конспекту + явний негативний перелік | 0, 1 |
| 4 | Контракт цитат | `citations` наскрізь + гейт у `handleSupportChat` | 1, 2, 3 |
| 5 | Видимість | лог + owner-ендпоінт + панель «що казав AI за 24 год» | 4 |
| 6 | Регресія | фікстура з реальним кейсом + повна перевірка | усі |

---

## ПАКЕТ 0 — Типізований доступ до рулбука

**Файл:** `lib/rules/rulebook.ts` (новий).

**Навіщо:** зараз єдиний, хто читає `rulebook.generated.json`, — UI вкладки «Правила».
AI має читати той самий файл, а не паралельний конспект.

**Точні сигнатури:**

```ts
export type RuleSection = { id: string; num: number; title: string; markdown: string }
export type Rulebook = { version: string; effective: string; sourceHash: string; sections: RuleSection[] }

/** Parsed once at module load. Throws RulebookInvalidError on a malformed file. */
export function getRulebook(): Rulebook
export function getSection(num: number): RuleSection | null
export class RulebookInvalidError extends Error {}
export const RULEBOOK_VERSION: string
```

**Вимоги:**

- Імпорт: `import raw from './rulebook.generated.json'` (resolveJsonModule уже працює —
  так робить `components/support/rules-browser.tsx`).
- Валідація при завантаженні: `sections` — масив, кожна секція має числовий `num`,
  непорожні `title` і `markdown`. Інакше `RulebookInvalidError`.
- `getSection(num)` — точний збіг за `num`, не за індексом масиву.
- Нічого не кешуй у модульних змінних понад одноразовий парс.
- **Не експортуй** сирий JSON назовні — тільки через `getRulebook()`.

**Заборонено:** редагувати сам JSON, додавати секції, змінювати `sourceHash`, тягнути
`docs/PFT-rulebook-v1.md` у рантайм (у проді його немає).

**Тести** (`scripts/rulebook-access.test.ts`, DB-free):
- `getRulebook().sections.length === 25`.
- Кожна секція має непорожній `markdown`.
- `getSection(18)?.title` містить `Fees`.
- `getSection(999) === null`.
- `RULEBOOK_VERSION === getRulebook().version`.

**Приймання:** `npx tsc --noEmit` чисто; новий тест зелений; `npm run rules:build` не
дає дифу.

---

## ПАКЕТ 1 — Grounding: відбір секцій і перевірка цитат

**Файл:** `lib/ai/grounding.ts` (новий). Це серце завдання: саме тут вигадка стає
**механічно неможливою**, а не «небажаною».

**Точні сигнатури:**

```ts
export type GroundingSection = {
  num: number
  title: string
  markdown: string
  kind: 'rule' | 'surface' | 'pricing'
}

export type Citation = { section: number; quote: string }

export type CitationFailure =
  | 'no_citations'
  | 'too_many_citations'
  | 'unknown_section'
  | 'quote_too_short'
  | 'quote_not_found'

export type CitationVerdict = { ok: true } | { ok: false; failures: CitationFailure[] }

export const MIN_QUOTE_CHARS = 20
export const MAX_CITATIONS = 3
export const MAX_SECTIONS = 5
export const MAX_SECTION_CHARS = 12_000

export function normalizeForMatch(text: string): string
export function selectSections(
  question: string,
  options?: { maxSections?: number; maxChars?: number },
): GroundingSection[]
export function verifyCitations(citations: unknown, sections: GroundingSection[]): CitationVerdict
export function formatSectionsForPrompt(sections: GroundingSection[]): string
```

### 1.1 `normalizeForMatch`

Детерміновано, без залежностей:

1. `String(text)`, замінити `\r\n` на `\n`.
2. Видалити markdown-розмітку: `**`, `*`, `` ` ``, `__`.
3. Замінити всі пробільні послідовності на один пробіл.
4. `trim()` і `toLowerCase()`.

Нічого більше. Ніяких транслітерацій і видалень діакритики — українська їх не потребує.

### 1.2 `selectSections` — правила відбору

Порядок **строго такий**, без «розумніших» евристик:

1. Нормалізуй питання. Розбий на токени за `[^\p{L}\p{N}]+` (unicode-властивості, не
   `\w` — інакше кирилиця зламається). Відкинь токени коротші за 3 символи. Дедуплікуй.
   Візьми перші 40 токенів.
2. **Таблиця псевдонімів** (у файлі, не в БД). Формат:
   ```ts
   const ALIASES: { sections: number[]; terms: string[] }[] = [
     { sections: [17], terms: ['payout', 'виплат', 'вивед', 'withdraw', 'profit split', 'спліт'] },
     { sections: [8], terms: ['inactiv', 'неактив', 'простой', 'idle'] },
     { sections: [18], terms: ['reset', 'ресет', 'frozen', 'замороз', 'фріз', 'add-on', 'аддон', 'fee'] },
     { sections: [9], terms: ['news', 'новин', 'blackout', 'економічн'] },
     // життєвий цикл акаунта: саме цей рядок обслуговує кейс «як заблокувати акаунт»
     { sections: [8, 18], terms: ['заблокув', 'блокув', 'block', 'закрит', 'закрий', 'close', 'пауз', 'pause'] },
     // «скільки часу на проходження» — найчастіше питання, тому окремий рядок
     { sections: [7, 8], terms: ['дедлайн', 'deadline', 'скільки часу', 'скільки днів', 'trading days', 'проходж', 'passed'] },
     // ... по одному рядку на кожну тему
   ]
   ```
   Мінімально покрий темами: продукти/цілі (3,4), daily loss (5), drawdown (6),
   trading days (7), inactivity (8), news (9), overnight (10), consistency (11),
   інструменти/плечі (12), виконання (13), заборонені практики (14), VPN/пристрої (15),
   кількість акаунтів (16), payout (17), fees/reset/add-ons (18), breach (19),
   review (20), KYC (21), platform risk (22), зміни правил (23).
   Терміни — українською, російською та англійською, бо трейдери пишуть усіма трьома.
   **Термін із `ALIASES` важить більше, ніж збіг у тілі** — інакше загальні слова
   («акаунт», «рахунок») витіснять тематичну секцію з топ-5.
3. **Скоринг** для кожної секції:
   - `+3` — токен питання збігається з токеном `title` (порівняння за першими 4
     символами нормалізованого токена; це дешевий стемер, більше не треба);
   - `+3` — токен питання містить будь-який **однослівний** термін із `ALIASES` для цієї
     секції (або термін містить токен — перевіряй в обидва боки, терміни короткі);
     терміни з пробілом (`'скільки часу'`, `'trading days'`) матчаться як підрядок
     нормалізованого питання, а не за токенами;
   - `+1` — токен питання (перші 4 символи) зустрічається в `markdown` секції.
4. Відбери секції зі score > 0, відсортуй за score спаданням, при рівності — за `num`
   зростанням.
5. **Додай `num: 1` (Терміни)** лише якщо після кроку 4 у виборі лишилось місце
   (`sections.length < maxSections`) — він потрібен для визначень, але не має витісняти
   тематичну секцію.
6. Обріж до `maxSections` (типово 5) і до `maxChars` (типово 12 000) — ріж з кінця
   відсортованого списку, ніколи не ріж секцію навпіл.
7. **Якщо score усіх секцій = 0 → поверни `[]`.** Порожній результат — це валідний
   сигнал «фактів немає», а не помилка.

`kind: 'rule'` для всіх секцій рулбука. Синтетичні секції (`kind: 'surface'` з `num: 0`,
`kind: 'pricing'` з `num: -1`) додаються **не тут**, а в пакеті 3 — `selectSections`
працює тільки з рулбуком.

### 1.3 `verifyCitations` — механічний гейт

Це головна гарантія. Правила, кожне з яких дає свій `failure`:

1. `citations` не масив → `no_citations`.
2. Порожній масив → `no_citations`.
3. Довжина > `MAX_CITATIONS` → `too_many_citations`.
4. Елемент не об'єкт, `section` не число, `quote` не рядок → `unknown_section`.
5. `section` немає серед переданих `sections` → `unknown_section`.
6. `normalizeForMatch(quote).length < MIN_QUOTE_CHARS` → `quote_too_short`.
7. `normalizeForMatch(section.markdown)` **не містить** `normalizeForMatch(quote)` як
   підрядок → `quote_not_found`.

Повертай **усі** зібрані failures, не першу. `ok: true` тільки коли список failures
порожній.

**Навіщо саме так:** вигадане речення неможливо процитувати з рулбука. Це єдина
перевірка, яку модель не може обійти «переконанням».

**Заборонено:** fuzzy-порівняння, нормалізація синонімів, порівняння за словами.
Тільки точний підрядок після `normalizeForMatch`. Інакше гейт стає «м'яким» і
пропускає переказ — а переказ і є джерелом вигадок.

### 1.4 `formatSectionsForPrompt`

```
### §{num} — {title}
{markdown}

```
(порожній рядок між секціями; без обгорток у markdown-код; `markdown` — дослівно).

**Тести** (`scripts/ai-grounding.test.ts`, DB-free):
- `normalizeForMatch` згортає пробіли, знімає `**` і регістр.
- **Питання «Як заблокувати акаунт?» → `selectSections` повертає секції, що містять 8
  і/або 18** (не порожньо).
- Питання «Яка ціна акаунта 25k?» → містить 3 або 4.
- Питання «abc» (сміття) → `[]`.
- **Кожна секція 1–24 і 29 досяжна**: для кожного `num` існує хоча б одне питання у
  фікстурі, яке його вибирає. Це захищає таблицю псевдонімів від «покрив тільки payout».
- `verifyCitations` позитивні: цитата, скопійована з §18.3, → `ok: true`.
- `verifyCitations` негативні: вигадана фраза → `quote_not_found`; чужий `num` →
  `unknown_section`; `'акаунт'` → `quote_too_short`; `[]` → `no_citations`;
  4 цитати → `too_many_citations`.
- **Цитата з §18.3, але заявлена як §8** → `quote_not_found` (міжсекційна підміна).

**Приймання:** усі тести зелені, `tsc` чисто.

---

## ПАКЕТ 2 — Детермінований ловець вигаданих фіч

**Файл:** `lib/ai/claim-guard.ts` (новий).

**Навіщо:** цитатний гейт ловить вигадку, лише якщо модель *не процитувала* джерело.
Якщо вона процитувала §18.3, а поруч написала «натисніть Freeze у кабінеті» — цитата
пройде. Потрібен другий, дешевий, детермінований шар.

**Точні сигнатури:**

```ts
export type ClaimHit = { id: string; reason: string; match: string }
export type ClaimRule = {
  id: string
  /** Fires on an affirmative claim only. */
  patterns: RegExp[]
  /** If the same sentence matches one of these, the hit is suppressed (negation). */
  negations: RegExp[]
  reason: string
}
export const CLAIM_RULES: ClaimRule[]
export function findForbiddenClaims(answer: string): ClaimHit[]
```

**Алгоритм:**

1. Розбий відповідь на речення за `[.!?…\n]+`. Порожні пропусти.
2. Для кожного речення і кожного правила:
   - якщо жоден `patterns` не матчиться → далі;
   - якщо матчиться хоч один `negations` **у тому ж реченні** → пропусти (це законне
     «кнопки не існує»);
   - інакше → `ClaimHit` з `match` = перші 120 символів речення.
3. Поверни всі хіти (дедуплікуй за `id`).

**Обов'язковий початковий набір правил** (id → що ловить). Розширювати можна, звужувати — ні:

| id | Ловить | Приклад, який МУСИТЬ спрацювати |
|---|---|---|
| `trader_freeze_feature` | «фріз/заморозка/freeze» + «кабінет/кнопка/dashboard/увімкни» | «використовуйте функцію Freeze у особистому кабінеті» |
| `self_service_closure` | «заблокувати/закрити акаунт» + «самостійно/в кабінеті/сам» | «закрити акаунт можна в кабінеті» |
| `on_demand_payout` | «payout/виплата» + «на вимогу/instant/миттєво/коли завгодно» | «замовте виплату на вимогу» |
| `refund_promise` | ствердне «повернемо/повертається/refund» без заперечення | «fee повертається після breach» |
| `inactivity_as_advice` | «неактивний/не торгуй» + «90» + спонукальне «подбай/зроби/дочекайся» | «подбайте, щоб акаунт був неактивний 90 днів» |
| `unlock_breach` | «розблокувати/відновити/повернути акаунт» після breach | «ми розблокуємо акаунт після breach» |
| `instant_withdrawal` | «виведення» + «за 5 хвилин/одразу/instant» | «кошти надходять одразу» |

**Негативні тести обов'язкові для кожного правила.** Приклади, які НЕ повинні
спрацьовувати:
- «У кабінеті немає функції заморозки акаунта.» (negation)
- «Fee не повертається.» (negation)
- «Frozen backup — це опція, яку купують на checkout; вона активується, якщо основний
  акаунт отримав breach.» (це правда, не вигадка)
- «90 календарних днів без торгівлі можуть призвести до закриття без refund; перед
  закриттям надсилається нагадування.» (це факт, не порада)

**Заборонено:** евристики на кшталт «якщо у відповіді є слово X, а в фактах немає —
відхилити». Це дасть масові false positives на законних переказах. Тільки курований
список із таблиці вище + негативні тести.

**Приймання:** окремий тест `scripts/ai-claim-guard.test.ts`; **дослівна відповідь з
розділу 0** дає ≥ 3 хіти (`trader_freeze_feature`, `inactivity_as_advice`,
`self_service_closure`).

---

## ПАКЕТ 3 — Ground-промпт замість конспекту

**Файли:** `lib/ai/pft-knowledge.ts` (переписати вміст, **зберегти експорти**),
`lib/ai/support-chat.ts` (передати секції).

**Точні сигнатури (публічний контракт не ламається):**

```ts
// pft-knowledge.ts — усі три експорти лишаються, змінюється лише реалізація
export const RULES_SOURCE_VERSION: string          // = RULEBOOK_VERSION
export function buildPftKnowledge(input: {
  pricing: PricingRow[]
  sections: GroundingSection[]
}): string
export const SUPPORT_SYSTEM_INSTRUCTIONS: string
export function categoryFromModel(value: unknown): SupportCategory
```

> **Увага:** сигнатура `buildPftKnowledge` змінюється з `(rows)` на `(input)`.
> Онови **всі** виклики (`lib/ai/support-chat.ts` і `scripts/ai-support.test.ts`).
> Якщо десь є виклик зі старою сигнатурою — `tsc` це покаже; не глуши через `as any`.

### 3.1 Що генерує `buildPftKnowledge`

Порядок блоків строго такий:

```
PFT RULES — версія {version}, чинна з {effective}. Джерело: офіційний рулбук PFT.
Відповідай ЛИШЕ на основі секцій нижче.

<formatSectionsForPrompt(sections)>

§0 — Можливості продукту та межі самообслуговування
<surface block>

§-1 — Ціни (з бази даних на момент запиту)
<pricing block>
```

**`surface`-блок (`num: 0`)** — синтетична секція, яку можна цитувати як звичайну.
Це відповідь на причину №4: модель має знати про відсутність. **Кожен пункт
обов'язково перевір по коду перед тим, як писати** — і залиш у коментарі поруч
файл-доказ:

| Твердження | Як перевірити |
|---|---|
| У кабінеті трейдера немає кнопки заморозки/блокування/паузи акаунта | `grep -rn "Freeze\|freeze" app components` → збіги лише в адмінці (`components/admin/admin-desk.tsx`) |
| Заморожений backup — це опція, яку купують на checkout, а не функція кабінету | `app/api/checkout/route.ts` → `hasFrozenBackup` |
| `FROZEN_STANDBY` — це системний стан backup-акаунта, а не дія трейдера | `prisma/schema.prisma` → `enum AccountStatus`, коментар до `EXPIRED` |
| Закриття акаунта — автоматичний процес (`inactivity`) або дія адміністратора; трейдер не закриває акаунт сам | `lib/accounts/inactivity.ts` (двофазне закриття з audit log) |
| Немає виплати «на вимогу» | §17 рулбука + `lib/payouts` |
| Немає повернення fee та add-on | §18.1, §17.5 рулбука |
| 90 днів неактивності — це наслідок правила, а не спосіб закрити акаунт | §8 рулбука |

Формат блоку — короткі твердження, 6–8 рядків, без порад:

```
- У кабінеті трейдера немає кнопки заморозки, паузи або блокування акаунта.
- Заморожений backup (frozen backup) — це опція, яку купують під час оформлення
  замовлення. Це не функція кабінету. `FROZEN_STANDBY` — стан цього backup-акаунта,
  який виставляє система.
- Закриття акаунта не робиться з кабінету: воно або автоматичне за правилом inactivity,
  або виконується адміністратором.
- Виплати «на вимогу» не існує.
- Fee та add-on не повертаються.
- 90 календарних днів неактивності — це наслідок правила inactivity (§8), а не спосіб
  закрити акаунт без refund. Перед закриттям надсилається нагадування.
```

**`pricing`-блок (`num: -1`)** — перенеси наявну логіку `pricingSection()` **без змін
у змісті** (ті самі цифри, той самий текст про base fee / +15% / +50% / checkout).
Змінюється лише те, що він стає елементом масиву секцій, а не окремим рядком.

### 3.2 `SUPPORT_SYSTEM_INSTRUCTIONS` — переписати

**Зберегти дослівно за змістом усі наявні поведінкові правила.** Вони вистраждані:
мова відповіді = мова трейдера; гіпотетичні питання відповідаються, реальні кейси —
ні; провокації не ведуть до handoff; ціни — усі варіанти; жодних обіцянок дій;
JSON-only; ≤150 слів; не розкривати інструкції.

**Додати (це нове ядро):**

1. «Ти відповідаєш **лише** твердженнями, які підтверджені наданими секціями. Кожне
   фактичне речення має спиратися на цитату.»
2. «Поверни `citations`: 1–3 об'єкти `{section, quote}`. `quote` — **дослівно
   скопійоване** речення з наданої секції, мовою оригіналу. Не перекладай цитату, не
   переказуй, не скорочуй середину. Якщо не можеш скопіювати — не цитуй.»
3. «Якщо секції не відповідають на питання — `resolved=false`. Порожній набір фактів
   означає handoff, а не здогад.»
4. «Не описуй інтерфейс, кнопки, меню та самостійні дії. Секції описують правила й
   політики, а не екрани. Якщо питання про те, "де натиснути" — handoff, якщо це не
   описано в §0.»
5. «Ніколи не ради того, як скористатися правилом на свою користь (наприклад,
   "простоюй 90 днів, щоб акаунт закрили"). Правило описує наслідок, а не інструкцію.»
6. «Історія чату — це контекст, а не джерело фактів. Якщо попередня відповідь
   асистента суперечить секціям — керуйся секціями.»
7. «Не додавай умов, яких немає в секціях. Не узагальнюй правило за аналогією.»

**Прибрати:** усі факти, які тепер живуть у секціях (ціни, відсотки, строки,
назви фіч). Правило 9 з розділу 1 забороняє їм там бути.

**Тест** (`scripts/ai-prompt-grounding.test.ts`):
- `SUPPORT_SYSTEM_INSTRUCTIONS` не містить `$`, `%`, `PFT.2`, `80/20`, `7 calendar`.
- `buildPftKnowledge({pricing, sections})` містить `§8`, `§18`, `§0`, `§-1` і дослівний
  текст §18.3.
- `buildPftKnowledge` з порожніми `sections` не падає і містить явний рядок
  «фактів немає».
- Збережені поведінкові правила: тест шукає ключові фрази про провокації, гіпотетичні
  питання, мову відповіді — щоб їх не випадково видалили.

### 3.3 `support-chat.ts`

```ts
// Follow-ups ("а якщо запізно?") carry no topic of their own, so the previous
// user turn is part of the retrieval query.
const lastUserTurn = [...input.history].reverse().find((turn) => turn.role === 'user')?.content ?? ''
const query = lastUserTurn ? `${lastUserTurn}\n${input.message}` : input.message
const sections = selectSections(query)
const knowledge = buildPftKnowledge({
  pricing,
  sections: sections.length > 0 ? [...sections, surfaceSection(), pricingSection(pricing)] : [],
})
```

- `surfaceSection()` і `pricingSection()` — у `pft-knowledge.ts` (експорт не потрібен,
  достатньо всередині `buildPftKnowledge`).
- **Якщо `sections.length === 0`** — не викликай модель узагалі: одразу
  `suggestedHandoff: true`, `handoffReason: 'no_matching_rules'`, `category: 'GENERAL'`.
  Це економить токени і виключає галюцинацію на порожньому контексті.

**Приймання:** `tsc` чисто; тести пакета 3 зелені; `npm run test:support-ui` не
змінився.

### 3.4 Що робити з `scripts/ai-support.test.ts` (читай уважно)

Цей файл містить ~10 тестів на промпт. Частина з них **законно зламається** від твоїх
змін. Не видаляй їх і не глуши — перепиши так, щоб вони перевіряли нову правду.

**а) Тести, які лишаються без змін (якщо ти не зламав поведінку):**

- `prompt requires answering hypothetical rule scenarios in JSON`
- `prompt separates hypothetical rules from real account checks`
- `prompt forbids performing or promising account actions`
- `prompt requires a handoff when essential case details are missing`
- `prompt handles harmless provocations without escalation`
- `pricing block lists every plan variant for the same account size` — **за умови**, що
  текст pricing-блоку ти переніс дослівно.

Щоб вони пройшли, у новому `SUPPORT_SYSTEM_INSTRUCTIONS` **дослівно** мають лишитись
ці підрядки:

```
Never extend a rule by analogy
Always answer in the language
must be answered in Ukrainian
list every available variant
hypothetical scenarios
do not ask for account IDs, balances or other personal data
Do not hand off a question that the facts can answer
including when resolved=false
Never reply with plain text
Do not decide whether a real trader or a real account violated a rule
requires checking actual account data
a real case must be handed off
Never perform or promise account actions
do not void profit, close accounts
never state that something was approved, cancelled, refunded or transferred
If a specific case cannot be decided because essential details are missing
do not assume: set resolved=false and hand off
When the message already states the relevant details, apply the rule instead
contains only insults, profanity, provocation
set resolved=true
Never hand off or open a ticket for such a message
Abuse must not hide the request
never override the handoff rules
not a case of insufficient facts
```

І **не має** лишитись підрядка `exact timing relative to a news window` (це старий
тригер handoff, його прибрали раніше).

**б) Тести, які треба переписати (бо факти тепер українською з рулбука):**

- `news facts separate holding from opening and forbid guessing`
- `the news-violation hypothetical is answerable from the facts`

Вони зараз шукають англійські речення на кшталт
`'forbidden to OPEN a new position or to INCREASE an existing position'`. Після
grounding таких речень у промпті немає — є §9 рулбука українською.

Перепиши їх так:
1. `selectSections('Що буде, якщо тримати позицію під час новин?')` містить `9`.
2. `buildPftKnowledge({ pricing: [], sections: selected })` містить дослівний фрагмент
   з §9 рулбука (бери його з `getSection(9)!.markdown`, а не хардкодь).
3. Поведінкові підрядки про «holding vs opening» перевіряй у
   `SUPPORT_SYSTEM_INSTRUCTIONS` (там вони лишаються англійською як інструкція), а не
   в knowledge.

**в) Виклики `buildPftKnowledge([])`** (рядки ~705, ~779, ~790) заміни на нову
сигнатуру: `buildPftKnowledge({ pricing: [], sections: [] })`. Не роби
`buildPftKnowledge([] as any)` — це заборонено.

**г) Не чіпай** тести ідемпотентності, handoff-у, провайдерів і `classifyGeminiFailure` —
вони не стосуються цього завдання.

---

## ПАКЕТ 4 — Контракт цитат наскрізь + гейт

### 4.1 Типи

`lib/ai/gemini.ts`:

```ts
export type AssistantResult = {
  answer: string
  resolved: boolean
  category: SupportCategory
  handoffReason: string | null
  /** 1–3 verbatim quotes from the provided sections. Empty when unresolved. */
  citations: Citation[]
}
```

`Citation` імпортуй із `lib/ai/grounding.ts`. **Поле обов'язкове в типі**, але
`parseAssistantResponse` має толерантно ставитись до його відсутності (`[]`), бо
staff-шлях (`lib/ai/agent-reply.ts`) цитат не повертає.

>через це `parseAgentReply` у `lib/ai/agent-reply.ts` теж треба доповнити
>`citations: []` — інакше `tsc` впаде на об'єктному літералі. Це один рядок,
>поведінка staff-агента не змінюється.

### 4.2 Схема Gemini

Додати в `responseSchema.properties`:

```ts
citations: {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: { section: { type: Type.NUMBER }, quote: { type: Type.STRING } },
    required: ['section', 'quote'],
  },
},
```

і в `required: ['answer', 'resolved', 'category', 'citations']`.

### 4.3 NVIDIA

`lib/ai/nvidia.ts` → `JSON_CONTRACT` доповнити описом `citations` тим самим текстом,
що й у Gemini. Обидва провайдери мають видавати однакову форму — інакше поведінка
залежить від `AI_PROVIDER`, а це неприпустимо.

Заодно перейменуй префікс контексту в обох провайдерах з `PFT FACTS:` на
`PFT GROUNDED FACTS:` — щоб у промпті було видно, що це цитовані секції, а не
«загальні знання». Більше нічого в цих файлах не змінюй.

### 4.4 `parseAssistantResponse`

- `citations` не масив → `[]` (не кидати помилку — це робить гейт нижче).
- Елементи: `section` — скінченне число, `quote` — рядок. Невалідні елементи
  **відкидай**, не ламай весь парс.
- Не валідуй тут зміст цитат — це робота `verifyCitations`.

### 4.5 Гейт у `handleSupportChatOnce`

Одразу після успішного `generate(...)` і **до** формування відповіді:

```ts
if (result.resolved) {
  const verdict = verifyCitations(result.citations, sections)
  const claims = findForbiddenClaims(result.answer)
  if (!verdict.ok || claims.length > 0) {
    // Never ship an ungrounded answer. Downgrade to a handoff suggestion.
    return {
      answer: null,
      handoff: null,
      handoffReason: claims.length > 0 ? 'forbidden_claim' : 'ungrounded_answer',
      suggestedHandoff: true,
      suggestedCategory: result.category,
      citations: [],
      grounding: claims.length > 0 ? 'forbidden' : 'ungrounded',
    }
  }
}
```

- `SupportChatResult` доповнити: `citations: Citation[]` і
  `grounding: 'grounded' | 'ungrounded' | 'forbidden' | 'no_matching_rules'`.
- `readSupportChatResult` має їх зберегти при читанні з кешу ідемпотентності
  (валідація нестрога: невірний тип → `[]` / `'ungrounded'`).
- Відповідь, що пройшла гейт, повертається з `citations` — вони підуть у UI.

### 4.6 Клієнт і UI

- `lib/ai/assistant-client.ts` → `AssistantChatResponse` + `citations?: {section:number;quote:string}[]`;
  `parseAssistantChatResponse` — нестрого (`[]`, якщо немає).
- `components/support/support-assistant.tsx` — під відповіддю, коли є цитати, дрібний
  рядок: `Rules: §18.3` (через кому, унікальні номери, максимум 3). Стиль —
  `text-[10px] text-muted-foreground`. Нічого більше: без акордеонів і попапів.

### 4.7 Тести (`scripts/ai-support-grounding.test.ts`, DB-free, мок генератора)

Мок `generate` повертає заготовлені `AssistantResult`. Перевір:

1. `resolved: true` + валідна цитата → `answer` повертається, `grounding: 'grounded'`.
2. `resolved: true` + вигадана цитата → `answer: null`, `suggestedHandoff: true`,
   `handoffReason: 'ungrounded_answer'`.
3. `resolved: true` + **дослівна відповідь з розділу 0** і валідною цитатою з §18.3 →
   `answer: null`, `handoffReason: 'forbidden_claim'`. (Цитата проходить, текст — ні.)
4. `resolved: true` + `citations: []` → `ungrounded_answer`.
5. `resolved: false` → handoff як раніше, `citations: []`.
6. `selectSections` → `[]` → модель **не викликається** (мок кине, якщо викликаний),
   `handoffReason: 'no_matching_rules'`.
7. Ідемпотентний повтор повертає той самий вердикт (через кеш).

**Приймання:** усі сім зелені; `tsc` чисто; `lint` 0 errors.

---

## ПАКЕТ 5 — Видимість: що асистент казав за 24 години

**Навіщо:** без цього власник не може ні оцінити масштаб, ні перевірити, що фікс
працює. Нову таблицю **не створюємо** — `prisma.aiSupportRequest.result` уже зберігає
повний `SupportChatResult`, і рядки живуть 24 години (`IDEMPOTENCY_TTL_MS`).

### 5.1 Лог

У `handleSupportChatOnce`, на кожній гілці повернення відповіді:

```ts
console.info('[pft ai]', JSON.stringify({
  event: 'ai_answer',
  grounding,                       // grounded | ungrounded | forbidden | no_matching_rules
  sections: sections.map((s) => s.num),
  citations: result.citations?.map((c) => c.section) ?? [],
  answerLength: result.answer?.length ?? 0,
  answerHash: sha256(answer).slice(0, 16),
  category,
  requestId: requestCorrelationId(input.request),
}))
```

- **Тіло відповіді в лог не писати.** Тільки хеш і довжина. Наявне правило
  «no PII in logs» лишається чинним.
- `sha256` — через `node:crypto`, без нових залежностей.

### 5.2 Ендпоінт

`app/api/admin/support/ai-audit/route.ts` (новий):

```
GET /api/admin/support/ai-audit?limit=50
```

- `requireAdmin()` — як у `app/api/admin/support/metrics/route.ts`.
- `limit`: 1..200, типово 50.
- Джерело: `prisma.aiSupportRequest.findMany({ where: { status: 'COMPLETED', createdAt: { gte: now-24h } }, orderBy: { createdAt: 'desc' }, take: limit })`.
- Відповідь: `{ items: [{ createdAt, category, grounding, answer, citations }] }`,
  де поля дістаються з `result` (валідуй через `readSupportChatResult`, невірні рядки
  пропускай).
- `answer` віддавай **тільки** якщо `grounding !== 'grounded'` — щоб не плодити
  сховище правильних відповідей. Для `grounded` віддавай `null` + `citations`. (Мета —
  ревʼю помилок, не архів.)
- `Cache-Control: no-store`.

### 5.3 Панель

`components/admin/support-desk.tsx` — у блоці підтримки додати **згорнутий** блок
«AI answers — last 24h»:

- Заголовок-кнопка з кількістю (`AI answers (24h) · 37`), `aria-expanded`.
- Розгортання підвантажує ендпоінт один раз.
- Рядок: час, `category`, чип вердикту (`grounded` зелений / `ungrounded` жовтий /
  `forbidden` червоний), текст відповіді для не-grounding, `§`-номери цитат.
- Порожньо → «No AI answers in the last 24 hours.»
- Ніяких дій, ніяких мутацій. Read-only.

**Приймання:** ендпоінт віддає 401 без сесії, 200 з даними під адміном; панель
розгортається; `lint` 0 errors.

---

## ПАКЕТ 6 — Регресійна фікстура і фінальна перевірка

### 6.1 Фікстура

`scripts/fixtures/ai-grounding.cases.json`:

```json
[
  {
    "id": "freeze-account",
    "question": "Як заблокувати акаунт?",
    "mustSelect": [18],
    "mustNotSay": ["функція «Freeze»", "у особистому кабінеті", "подбайте"],
    "expectedVerdict": "grounded_surface_or_handoff"
  }
]
```

`mustSelect` = **усі** перелічені номери мають бути у виборі `selectSections`.
Якщо для кейсу достатньо будь-якої з кількох секцій — заведи окремі кейси, не
послаблюй перевірку.

Мінімум **25 кейсів**. Обов'язково покрий:
- блокування/закриття акаунта (реальний кейс);
- заморожений backup (що це насправді);
- payout: перша виплата, частота, консистентність, мінімум;
- news window: холдинг vs відкриття, 60 хвилин;
- daily loss / trailing vs static drawdown;
- reset: знижка, ліміт, коли недоступний;
- inactivity 60/90;
- KYC;
- ліміт акаунтів і алокація;
- ціни: кілька варіантів на один розмір;
- «скільки часу на проходження»;
- провокація без питання (має бути `resolved`, не handoff);
- гіпотетичне питання про правило (має бути відповідь, не handoff).

### 6.2 Тест

`scripts/ai-grounding-fixtures.test.ts` (DB-free):
- Для кожного кейсу: `selectSections(question)` містить усі `mustSelect`.
- Для кожного `mustNotSay`: `findForbiddenClaims(відповідь)` не потрібен — перевіряй,
  що жоден **дозволений** шлях не продукує цих фраз. Практично: перевір, що
  `findForbiddenClaims` ловить кожну фразу з `mustNotSay`, якщо вона стоїть у
  ствердному реченні (тобто фікстура узгоджена з правилами).
- Дослівна відповідь з розділу 0 (поклади її у фікстуру як `reported_answer`) дає
  `forbidden_claim` через `findForbiddenClaims`.

### 6.3 npm-скрипт

```json
"test:ai-grounding": "node scripts/run-db-free-tests.cjs --import tsx --test scripts/rulebook-access.test.ts scripts/ai-grounding.test.ts scripts/ai-claim-guard.test.ts scripts/ai-prompt-grounding.test.ts scripts/ai-support-grounding.test.ts scripts/ai-grounding-fixtures.test.ts"
```

Додати `npm run test:ai-grounding` у `test:unit` (перед `test:ai-support`).

### 6.4 Фінальна перевірка — усе має бути зеленим

```bash
npx tsc --noEmit
npm run lint                    # 0 errors (warnings — як було)
npm run test:ai-grounding
npm run test:support-ui         # 15/15, не менше
npm run rules:build             # без дифу
```

`npm run test:ai-support` — **зафіксуй цифри до і після**. Якщо червоний з тієї ж
причини (`loadPricing is not a function`) — це пре-існуючий стан, напиши в PR.

### 6.5 Ручний сценарій (виконай і опиши результат)

1. Увійти трейдером, відкрити чат підтримки.
2. Запитати: «Як заблокувати акаунт?»
   **Очікування:** або відповідь, що спирається на §0 («у кабінеті немає такої функції,
   закриття виконує підтримка») з цитатою, або handoff. **У жодному разі** не «функція
   Freeze у кабінеті» і не порада простоювати 90 днів.
3. Запитати: «Що таке frozen backup?»
   **Очікування:** правильна відповідь про опцію на checkout, цитата з §18.3.
4. Запитати: «Скільки часу в мене на проходження?»
   **Очікування:** відповідь з §8 (дедлайну на проходження немає, inactivity — окреме
   правило), без вигаданих строків.
5. Запитати: «Яка ціна акаунта 25k?»
   **Очікування:** усі варіанти, base fee, застереження про checkout.
6. Запитати щось поза рулбуком: «Чи можна перевести акаунт на іншу людину?»
   **Очікування:** handoff, без вигаданої процедури.
7. Запитати провокацію без питання (лайка). **Очікування:** коротка відповідь, не handoff.
8. Відкрити адмінку → «AI answers (24h)»: переконатись, що записи з'явились і вердикти
   проставлені.
9. Перевірити, що цитати в UI показуються як `Rules: §18.3`.
10. Перевірити, що відповіді трейдера й далі в його мові (укр. питання → укр. відповідь,
    англ. → англ.).
11. Перевірити, що після handoff створюється тікет і в ньому є brief.

---

## ДОДАТОК A — журнал рішень (не переглядай, виконуй)

1. **Чому цитати, а не «сильніший промпт».** Імператив «не вигадуй» неможливо
   перевірити. Підрядок у тексті — можна. Тому контракт цитат + `verifyCitations`.
2. **Чому точний підрядок, а не семантична схожість.** Схожість пропускає переказ,
   а переказ і є механізмом вигадки. Краще відхилити правильну відповідь, ніж
   пропустити вигадану.
3. **Чому `selectSections` без embeddings.** Немає ні залежностей, ні бюджету на
   індексацію. 25 секцій закриваються таблицею псевдонімів + простим скорингом.
   Якщо покриття виявиться поганим — це видно з тесту «кожна секція досяжна».
4. **Чому `num: 0` і `num: -1`.** Цитата має вказувати на щось у наданому контексті.
   Surface- і pricing-блоки — теж контекст, тому вони синтетичні секції, а не «просто
   текст у промпті». Так гейт їх теж перевіряє.
5. **Чому не таблиця в БД для аудиту.** `AiSupportRequest.result` уже містить усе і
   живе 24 години. Міграція не потрібна, а 24 години достатньо, щоб побачити масштаб.
6. **Чому handoff — прийнятна ціна.** Хибна відповідь коштує дорожче, ніж зайвий
   тікет. Метрика `grounding` у логах покаже, чи не занадто часто ми йдемо в handoff;
   якщо так — розширюй `ALIASES`, а не послаблюй гейт.

---

## ДОДАТОК B — анти-скоуп (не роби цього)

- Не додавай embeddings, векторні БД, `pgvector`, LangChain, RAG-фреймворки.
- Не переноси відповіді в `SupportMessage` і не показуй AI-відповіді в тікеті.
- Не роби стрімінг відповіді.
- Не чіпай staff-агента (`lib/ai/agent-tools.ts`, `support-agent-panel.tsx`) — у нього
  інший контракт і свої тести.
- Не «покращуй» рулбук, не додавай нових правил у продукт.
- Не роби детектор суперечностей у відповіді (семантичний аналіз) — поза скоупом.
- Не додавай i18n-фреймворк для `§`-рядка.
- Не змінюй ліміти історії, rate-limit, ідемпотентність.

---

## ДОДАТОК C — що робити, якщо незрозуміло

- **Сумніваєшся, чи існує фіча** → `grep` по `app/` і `components/`. Немає збігу в
  трейдерському UI = фічі немає. Не пиши «мабуть є».
- **Сумніваєшся, яку секцію вибирати** → подивись `title` секції в
  `rulebook.generated.json`. Якщо жодна не підходить — це сигнал, що питання поза
  рулбуком, і правильна відповідь — handoff.
- **Тест падає через пре-існуючу причину** → перевір на `git stash`-версії. Якщо падає
  там само — зафіксуй у PR і йди далі. Не «фіксь» чуже.
- **Суперечність між цим файлом і кодом** → пріоритет у цього файлу, суперечність — у PR.
- **Не виходить зробити пакет за 1 коміт** → дроби коміт на підпакети, але не переходь
  до наступного пакета з червоними тестами.
