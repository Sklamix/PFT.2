# PHASE 1.14 — Owner Configuration Completion + Environment Isolation Verification + Final Infrastructure Readiness

Дата: 2026-11-12
Статус: **PARTIAL** — увесь дозволений безпечний обсяг виконано; конфігураційні дії власника (перевірені свіжим аудитом) ще не застосовані.
Базис: PHASE 1.13 (PARTIAL), branch `staging/ai-support-reliability`, HEAD `6561d8b` (не змінено).

---

## A. Executive Summary

**Статус: PARTIAL.**

Фактично виконані зміни цього етапу:

1. **Preview URL — fail-closed посилення (§6).** `lib/app-url.ts` переписано під нові правила: preview deployment без визначеного домену тепер **кидає контрольовану помилку** замість мовчазного fallback на Production URL; development отримує безпечний локальний дефолт `http://localhost:3000`; значення в лапках нормалізується; некоректне значення `NEXT_PUBLIC_APP_URL` (без схеми) → гучна помилка з `cause`. Оновлено regression-набір: 9 тестів.
2. **NOWPayments (§7)** — зафіксовано контракт fallback-секрету (`NOWPAYMENTS_IPN_KEY`) новим тестом (14-й у наборі). Головний результат: знайдено **точний безпечний механізм** для живого Preview-вебхука без вимкнення SSO — Vercel *Protection Bypass for Automation* з query-параметром (документовано Vercel саме для «third-party webhook services that cannot set custom headers»). Recipe в K-4.
3. **Свіжий аудит конфігурації (§2.3, §3.1, §4):** власник ще не виконав жодну з дій 1.13 — `DATABASE_URL` досі одна записка Production+Preview; `RESEND_API_KEY` не оновлювався (створення 23d ago); `RESEND_FROM_EMAIL` локально досі порожній; `OBSERVABILITY_TEST_DB_URL` відсутній; `NOWPAYMENTS_IPN_KEY` — production-only. Тому: 19 DB-gated тестів — чесно SKIPPED; Resend-конфігурація — відкрита; DB-ізоляція на рівні значень — CRITICAL BLOCKER.

Перевірені результати: регресія **634 / 553 PASS / 0 FAIL / 81 SKIP** (дельта +3 тестів — пояснена); tsc 0; ESLint 0 errors; prisma validate valid; production build OK; `git diff --check` чисто; Production і Git-історію не змінено.

Підготовлені інструкції: K-1…K-5 (CRITICAL/HIGH) — з точними місцями, scope, форматами значень, prerequisites, перевірками та ризиками бездіяльності.

---

## B. Git State

| Параметр | Значення |
|---|---|
| Branch | `staging/ai-support-reliability` |
| HEAD | `6561d8b317a74d49c696e028a124d20ad5f638e7` — не змінено, нових комітів немає |
| Записів у `git status` | 115 (незмінно щодо кінця 1.13: цього етапу змінювалися лише вже існуючі untracked-файли) |

Modified/untracked цим етапом: `lib/app-url.ts` (переписано), `scripts/app-url.test.ts` (переписано, 9 тестів), `scripts/webhook-ipn.test.ts` (додано тест 14). Коміт/push/merge/reset/clean не виконувалися; усі початкові зміни збережено.

---

## C. Resend

### Перевірка реалізації PHASE 1.13 (§2.1) — підтверджено

- `isProductionRuntime()` / `resolveSender()` / `classifyResendFailure()` на місці в `lib/email/resend.ts`.
- Production fail-closed: відсутній/порожній `RESEND_FROM_EMAIL` → FAILED без HTTP-виклику + `console.error` (тести 1–3 email-sender-policy; 3b email-transport).
- Немає шляху до `onboarding@resend.dev` у production: fallback існує лише в dev/тестовому рантаймі (тести 4, 5).
- Розділення: production (`NODE_ENV`/`VERCEL_ENV`) → fail-closed; development → sandbox fallback для Mailpit; тести → resend-шлях.
- Класифікація 422 (sandbox/домен), 401/403 (API key), інші статуси — без змін формату; без витоку отримувача/тіла (тести 6, 9 email-sender-policy).
- Усі 24 email call-sites через єдиний `sendEmail` (постійний тест 11 email-transport).

### Конфігураційний стан (свіжий аудит)

| Джерело | Факт |
|---|---|
| Vercel `env ls` | `RESEND_API_KEY`: Production+Preview, запис **не оновлювався** (23d) → non-sandbox ключ не встановлено |
| Vercel `env ls` | `RESEND_FROM_EMAIL`: окремі записи Production/Preview/Development (15d) — значення masked, перевірити неможливо |
| `.env.local` | `RESEND_FROM_EMAIL` присутнє, але **порожнє** |

Висновок: owner action K-1 (1.13) **не виконано** → живе контрольоване тестове надсилання (§2.3) не проводилося — надсилати листи без верифікованого домену заборонено правилами етапу. Пункт залишається відкритим.

### Owner configuration checklist (§2.2)

| Параметр | Призначення | Scope | Перевірка | Залежності | Очікувана поведінка |
|---|---|---|---|---|---|
| Verified sending domain | Дозволяє Resend доставляти будь-яким отримувачам | Resend Dashboard → Domains (DNS SPF/DKIM) | Статус «Verified» у дашборді | Доступ до DNS домену | 422 «sandbox» зникає |
| Non-sandbox API key | Знімає обмеження отримувачів на рівні ключа | Resend Dashboard → API Keys → Full Access | Створено; замінити `RESEND_API_KEY` у Vercel production (та окремий для preview) | Верифікований домен | Відправка без «testing email address» |
| `RESEND_FROM_EMAIL` | Відправник листів; production-рантайм відмовляється шле без нього (fail-closed) | Vercel → production (обов'язково), preview/development (окремі значення) | Формат `PFT Challenges <noreply@домен>`; домен = верифікований | Ключ + домен | Код шле з цього відправника; логи без «send refused» |

Після застосування: контрольоване надсилання тільки на авторизовану тестову адресу, перевірка 200-відповіді і відсутності 422 (передбачено §2.3; зараз неможливо — конфігурація відсутня).

---

## D. Database Isolation

### Повторний аудит (§3.1) — свіжий `vercel env ls` (names/scopes only)

| Variable | Development | Preview | Production | Примітка |
|---|---|---|---|---|
| `DATABASE_URL` | — (власний локальний `.env.local` → `neondb`, не `pft_dbtest`) | **та сама записка, що Production** | так | **Єдиний запис Production+Preview → спільне значення не виключено** |
| `DIRECT_URL` | — | відсутня | відсутня | не використовується |
| `NOWPAYMENTS_IPN_KEY` | — | відсутня | є | preview все ще без IPN secret |
| `NEXT_PUBLIC_APP_URL` | — (локально `"http://localhost:3000"`) | відсутня | є (Config, masked) | покривається fallback-ом `appUrl()` |
| `TRADER_SESSION_SECRET` | є | є | є | OAuth secret-fallback валідний |
| Workers/cron | використовують ті самі scope-набори; окремих DB-змінних немає | | | |

### Бажана конфігурація (опис, НЕ дозвіл змінювати; §3.2)

| Variable | Development | Preview | Production |
|---|---|---|---|
| `DATABASE_URL` | окрема dev DB (`.env.local`) | **окрема Preview DB** (окремий запис у preview scope) | **Production DB** (окремий запис у production scope) |
| `DIRECT_URL` | dev direct URL (якщо буде потрібен) | Preview direct URL | Production direct URL |

Ключова перевірка §3.2 — «чи може Production deployment отримати Preview database URL»: з поточної конфігурації неможливо довести зворотне — один запис на обидва скопи означає одне значення на обидва скопи. **Це CRITICAL BLOCKER** (K-2).

### Database identity verification (§3.3) — UNVERIFIED

`current_database()`/`current_user`/`current_schema()`/server identity недоступні безпечно: Vercel повертає `[SENSITIVE]` для secret-змінних у `env pull`, а з'єднання з Production/Preview БД без окремого дозволу заборонене. Порівняння з очікуваною конфігурацією можливе лише після K-2 (перевірка описана там же).

### Fail-closed protection (§3.4) — підтверджено

- Гейт тестів (`scripts/test-db-guard.ts` + `scripts/observability-db-gate.ts`): exact host allowlist (production-хост `ep-jolly-resonance` жорстко заборонений), обов'язковий db `pft_dbtest`, `sslmode=verify-full`, жива перевірка `current_database()` — власні тести гейта зелені в загальному прогоні.
- `claimWebhookEvent`/`releaseWebhookEvent` мають власні `!process.env.DATABASE_URL` no-op гварди; webhook-роут відповідає 503 без `DATABASE_URL`.
- Локальні DB-mutating скрипти: `bootstrap-production.cjs` (гвард `PFT_BOOTSTRAP=1`) і `migrate-stress-test.cjs` (гвард `PFT_STRESS_MIGRATIONS=1`) — no-op локально; build безпечний.

---

## E. `pft_dbtest`

- `OBSERVABILITY_TEST_DB_URL`: відсутній і локально, і на Vercel (свіжий `env ls`). `neondb` як заміна не використовувався; credentials не вгадувалися/не перебиралися; connection string не виводився.
- Гейт працює і відмовляє некоректні URL (D). Валідний credential — передумова F.
- Точна інструкція власника — K-3 (без змін щодо 1.13).

## F. 19 DB-Gated Tests

**19/19 SKIPPED** (чесно, з точними причинами): 10× `DB writes not authorized: requires OBSERVABILITY_TEST_DB=1 and OBSERVABILITY_TEST_DB_URL for the isolated pft_dbtest database`; 9× `requires PAYOUT_CONCURRENCY_TEST_DB=1 and PAYOUT_CONCURRENCY_TEST_DB_URL (isolated pft_dbtest)`.

Per-test результат фіксуватиметься після виконання K-3 (очікування 19/19 PASS). Failures не маскуються; SKIP тут — єдиний чесний стан без доступу до БД.

---

## G. Preview URL (§6) — fail-closed посилення

### Нова поведінка `lib/app-url.ts`

| Сценарій | Поведінка до 1.14 | Поведінка зараз |
|---|---|---|
| Явний `NEXT_PUBLIC_APP_URL` | перемагає | перемагає; лапки знімаються; значення валідується як absolute http(s) URL |
| Preview + `VERCEL_URL` | `https://$VERCEL_URL` | без змін |
| Preview без `VERCEL_URL` | **мовчазний Production URL** | **контрольована помилка** «Preview app URL cannot be determined…» |
| Production runtime | канонічний Production URL | без змін |
| Development (`NODE_ENV`/`VERCEL_ENV=development`) | Production URL | **`http://localhost:3000`** (безпечний локальний дефолт) |
| Невідомий рантайм (тести/скрипти) | Production URL | без змін |
| Некоректне значення (без схеми) | мовчазно використовувалося | **гучна помилка** з `cause` |

Throw-поведінка безпечна для всіх реальних шляхів: у справжніх preview deployment'ах `VERCEL_URL` завжди присутній (throw — лише ознака зламаної конфігурації); production має var або коректний дефолт; dev отримує localhost. Caller-и: credentials email, password reset, breach-notice, checkout success/cancel, certificate `verifyUrl` — усі через спільний `appUrl()` (тест 9 перевіряє wiring); помилкова конфігурація preview проявиться як FAILED email/500 з чіткою причиною, а не як Production-посилання у прев'ю-листах.

### Regression tests

`scripts/app-url.test.ts` — 9 тестів: явний var перемагає (+slash-stripping); preview→`VERCEL_URL`; порожній var→`VERCEL_URL`; **fail-closed throw** для preview без `VERCEL_URL` (включно з empty-string); production ігнорує `VERCEL_URL`; невідомий рантайм→дефолт; **development→localhost** (включно з `VERCEL_ENV=development` і лапками у var); **throw** для scheme-less/malformed значення + fallback для «тільки лапки»; wiring делегатів.

### OAuth callbacks / redirects (§6)

OAuth вимкнений (I) — callback-и неактивні; redirect-валідація login-потоків через `resolveSafeNextPath` (використовується в `AuthCard`, `/api/auth/google/complete`) покрита `auth-policy.test.ts` (зелений у прогоні). Після майбутнього включення OAuth — K-5 (`NEXT_PUBLIC_APP_URL` у preview) дає коректні redirect-и.

---

## H. NOWPayments (§7)

### Локальний harness — завершено

`scripts/webhook-ipn.test.ts` — **14 тестів PASS** (реальні HMAC-SHA512 фікстури): валідний PAID → умовне оновлення; invalid/tampered signature → 401 (нуль БД-звернень); missing secret → 503 fail-closed; duplicate → `{duplicate:true}`; пізній FAILED після PAID → без апдейтів; unknown order → 404+release; conditional-оновлення FAILED; lost race → «still PAID»; intermediate (waiting) → only-acknowledge; 400-и; **нове (1.14):** контракт секрету через `NOWPAYMENTS_IPN_KEY` fallback — працює і теж вимагає валідного підпису.

### Живий Preview-вебхук — знайдено безпечний шлях (recipe для власника)

Свіжі факти: `NOWPAYMENTS_IPN_KEY` — production-only; preview SSO-protected; NOWPayments не підтримує кастомні заголовки в IPN-callback.

Знайдене рішення (документовано Vercel для саме цього випадку): **Protection Bypass for Automation** підтримує **query-параметр** `?x-vercel-protection-bypass=<secret>` — «required for webhook URLs», «Third-party webhook services (Stripe, GitHub, etc.) that cannot set custom headers». Recipe (K-4):

1. Vercel → Settings → Deployment Protection → **Protection Bypass for Automation** → enable (доступно на всіх планах) → згенерований secret як `VERCEL_AUTOMATION_BYPASS_SECRET`.
2. У NOWPayments задати Preview callback URL: `https://<preview-url>/api/webhooks/payment-success?x-vercel-protection-bypass=<bypass-secret>`.
3. Встановити **окремий** `NOWPAYMENTS_IPN_SECRET` у preview scope (не production значення).
4. Безпека: SSO головного preview залишається включеним (bypass відкриває лише запити, що пред'являють secret); сам ендпоінт незалежно захищений обов'язковою HMAC-перевіркою (401 на підробку підтверджено тестами) + 503 без секрету. Bypass secret трактувати як конфіденційний; при витоку — ротувати.

Обмеження, задокументоване Vercel: bypass діє на «all deployments in a project» — для PFT це не додає ризику (production-домени й так публічні за Standard Protection). Альтернатива, якщо bypass неприйнятний: окремий webhook-only Vercel-проєкт без protection (більше роботи, той самий рівень безпеки завдяки HMAC).

Production webhook configuration не змінювалася; production secret у Preview не використовувався.

---

## I. OAuth

- Відсутність `AUTH_GOOGLE_ID/SECRET` → порожній список провайдерів; email/password auth працює (auth-набори зелені в регресії).
- Частково налаштований стан (тільки ID) → провайдер не активується; runtime-помилок немає; secret-fallback `AUTH_SECRET || TRADER_SESSION_SECRET` валідний у всіх скопах.
- Credentials не створено; OAuth не активовано; Production settings не змінено. Для майбутнього включення — K-5/OPTIONAL.

## J. Regression

| Перевірка | Результат |
|---|---|
| Повний прогін | **634 тести / 553 PASS / 0 FAIL / 81 SKIP**, exit 0 (двічі: до і після lint-фіксу) |
| Бейзлайн 1.13 | 631 / 550 / 0 / 81 |
| Дельта | **+3 тести / +3 PASS / skips без змін** — пояснено: app-url 7→9 (fail-closed preview throw + dev localhost), webhook-ipn 13→14 (KEY-fallback контракт) |
| SKIP склад | без змін: 72 observability-gated + 9 payout-gated (причини в F) |
| `npm run test:db:gated` | 19/19 SKIPPED |
| TypeScript `npx tsc --noEmit` | exit 0 |
| ESLint | **0 errors**, 63 warnings (pre-existing); проміжний 1 error (`preserve-caught-error` у новому `throw` без `cause`) виправлено в межах етапу — фінальний прогін 0 errors, exit 0 |
| `npx prisma validate` | valid (warn `package.json#prisma` → Prisma 7, відоме OPTIONAL-рішення) |
| `npm run build` | exit 0 |
| `git diff --check` | чисто (лише pre-existing CRLF-попередження) |

## K. Owner Actions

### CRITICAL

**K-1. Resend (не виконано — перевірено свіжим аудитом).** Де: Resend Dashboard + Vercel → Settings → Environment Variables. Параметри/формат: верифікований sending domain (DNS SPF/DKIM); non-sandbox Full Access API key → замінити `RESEND_API_KEY` у **production** (та окремий для preview); `RESEND_FROM_EMAIL` = `PFT Challenges <noreply@<домен>>` у **production**. Prerequisites: доступ до DNS. Перевірка успіху: контрольний лист на авторизовану адресу доставлений; у логах немає `[pft email] send refused` і немає 422. Ризик бездіяльності: усі транзакційні листи в Production падають (422), реєстрація/відновлення паролю/credentials-листи не працюють.

**K-2. Розділити `DATABASE_URL` за скопами (CRITICAL BLOCKER).** Де: Neon Console (окрема preview-БД/branch) + Vercel → Settings → Environment Variables. Параметр: окремі записи `DATABASE_URL` для **preview** і **production** (формат — стандартний Neon connection string; значення не друкувати). Prerequisites: створена preview-БД. Перевірка успіху: `vercel env pull --environment preview` показує інший хост/ім'я БД ніж production (masked-порівняння хоста); після deploy — логи preview без звернень до production-хоста; за потреби тимчасовий read-only діагностичний ендпоінт з `current_database()`. Ризик бездіяльності: прев'ю може писати в Production-базу; будь-яка помилка тестування змінює реальні дані.

**K-3. `pft_dbtest` credentials.** Де: Neon Console → схвалений тестовий endpoint (`ep-icy-king-…`, НЕ `ep-jolly-resonance`) → створити БД `pft_dbtest` + користувача; локально `OBSERVABILITY_TEST_DB_URL=<connection string>` + `OBSERVABILITY_TEST_DB=1` (аналогічно `PAYOUT_CONCURRENCY_TEST_DB_URL` для 9 payout-тестів). Перевірка: `npm run test:db:gated` → **19/19 PASS**. Ризик: DB-рівень логіки без виконавчого покриття.

### HIGH

**K-4. NOWPayments Preview (новий точний recipe).** Де: Vercel → Settings → Deployment Protection → Protection Bypass for Automation (enable → secret); NOWPayments → Preview callback URL з `?x-vercel-protection-bypass=<secret>`; Vercel → preview scope → `NOWPAYMENTS_IPN_SECRET` (окреме значення). Перевірка: підписана фікстура → 200; підроблений підпис → 401; без секрету → 503; головний preview досі 401 для звичайних запитів. Ризик бездіяльності: реальний вебхук-шлях payment→provisioning вперше виконається тільки в Production.

**K-5. `NEXT_PUBLIC_APP_URL` у preview scope** (URL прев'ю deployment-а). Після 1.14 код покриває відсутність через `VERCEL_URL`, але явне значення надійніше (OAuth/KYC callback-и майбутнього). Ризик: мінімальний (fallback працює).

### OPTIONAL

**K-6.** Prisma 7 upgrade decision (`package.json#prisma` deprecated). **K-7.** OAuth credentials (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`, Google Console redirect URIs). **K-8.** Тестові акаунти Admin/Trader для живих workflow-перевірок.

---

## L. Production Safety

- Production env vars/database/Resend/payment configuration/deployment protection: **не змінювалися** (звернення до Vercel — лише read-only `env ls` і `env pull --environment preview` в 1.13; секрети не друкувалися; тимчасові env-pull файли видалялися одразу).
- Migrations/DDL/DML/`prisma db push`: не виконувалися; production deployment не створювався (build — локальний).
- Реальні платежі/виплати/вебхук-транзакції: не запускалися; harness — локальний з моками.
- Git: HEAD не змінено, комітів немає, reset/clean не виконувалися, усі 115 записів збережено.
- Secrets: не надруковані й не записані в документацію; у тестах лише фіктивні значення.

## M. Final Owner Summary (українською)

**Що зроблено на цьому етапі.** Я закрив увесь кодовий обсяг, який міг виконати самостійно й безпечно. По-перше, посилив логіку URL: тепер прев'ю-середовище без визначеного домену свідомо «падає» з зрозумілою помилкою, замість того щоб мовчки генерувати посилання на ваш бойовий домен; локальна розробка отримала безпечну localhost-конфігурацію, а некоректно задана адреса теж дає гучну помилку замість зламаних листів. По-друге, знайшов точний задокументований Vercel-механізм (Protection Bypass for Automation із query-параметром), який відкриває ШЛЯХ до живої перевірки платіжного вебхука у прев'ю — без вимкнення SSO і без відкриття всього прев'ю: захистом залишається обов'язкова криптографічна перевірка підпису. По-третє, свіжим аудитом підтвердив: жодна з конфігураційних дій, описаних у 1.13, ще не виконана — база даних досі має спільне значення для Production і Preview, Resend-ключ досі пісочний, тестова база досі недоступна.

**Перевірені результати:** повна регресія 634 тести — 553 успішні, 0 провалів, 81 чесних пропусків (без змін у складі пропусків); TypeScript, ESLint, Prisma-валідація, production-збірка — чисто; Production і історія Git не торкані; усі ваші попередні незакомічені зміни на місці.

**Що залишилося — тільки ваші дії (у пріоритеті):** (1) Resend — верифікувати домен, створити повноцінний ключ і вказати відправника, інакше реальні клієнти не отримують листів; (2) розділити базу даних між Production і Preview — це головний ризик, доки значення спільне; (3) створити тестову базу `pft_dbtest` з валідними credentials — тоді 19 заблокованих тестів запустяться і я очікую 19/19 PASS; (4) для платіжного вебхука в прев'ю — увімкнути Protection Bypass for Automation і задати окремий preview-секрет (покроково в K-4). Після цих чотирьох дій я зможу виконати фінальну верифікацію (ідентичність баз, контрольний email, 19/19 тестів) і етап можна буде закрити як PASS.
