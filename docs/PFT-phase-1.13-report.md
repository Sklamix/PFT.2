# PHASE 1.13 — Production Email Recovery + Database Isolation + Test Environment Restoration

Дата: 2026-11-12
Статус: **PARTIAL** — усі дозволені кодові та тестові роботи виконані й зелені; залишаються 4 блокери, які вимагають дій власника (див. розділ K).
Базис: PHASE 1.12 (PARTIAL), branch `staging/ai-support-reliability`, HEAD `6561d8b`.

---

## A. Executive Summary

**Статус: PARTIAL.**

Що завершено (кодові зміни + тести, усе без Production-мутацій):

1. **Resend 422 — коренева причина локалізована й закрита на рівні коду.** Впроваджено fail-closed політику відправника для production-рантаймів + класифікацію помилок Resend. Production більше не може мовчки відправляти з sandbox-адреси `onboarding@resend.dev`.
2. **NOWPayments IPN — повний локальний harness з реальними підписаними фікстурами.** Сигнатурні хелпери витягнуто в спільний модуль; 13 нових тестів покривають валідний PAID-потік, відхилення підроблених підписів, fail-closed без секрету, дедуплікацію, захист PAID від пізніших FAILED, невідомі замовлення та проміжні статуси.
3. **Preview App URL — виправлено.** Створено спільний `lib/app-url.ts`: явний `NEXT_PUBLIC_APP_URL` → `https://$VERCEL_URL` у Preview → канонічний Production-домен. Всі email-посилання, redirect-и та certificate-верифікація тепер середовищно-коректні. Додано 7 regression-тестів.
4. **Idempotency-ключі додано** до email-повідомлень про закриття угод та news-порушення (`trade-close-*`, `news-*`); `orderEmail` свідомо без ключа (немає стабільного id, upstream one-shot).
5. **OAuth підтверджено безпечно вимкненим** (без credentials, без небезпечних fallback).
6. **Regression suite повністю зелена:** 631 тестів / 550 PASS / 0 FAIL / 81 SKIP (+31 тестів проти бейзлайну 600/519/0/81 — усі нові; skips без змін). tsc, ESLint, prisma validate, production build, `git diff --check` — чисто.

Основні ризики, що залишилися (усі owner-only):

- **CRITICAL:** Resend досі працює з sandbox API key — реальні листи отримують 422, доки власник не верифікує домен і не замінить ключ (`RESEND_FROM_EMAIL` у production теж потрібен).
- **CRITICAL:** `DATABASE_URL` однакове значення для Production+Preview — value-level ізоляція не підтверджена (значення замасковані на рівні Vercel; кодово перевірити неможливо).
- **CRITICAL:** валідні credentials для `pft_dbtest` відсутні → 19 DB-gated тестів чесно SKIPPED.
- **HIGH:** у Preview відсутні `NOWPAYMENTS_IPN_SECRET` і `NEXT_PUBLIC_APP_URL`; вебхук-ендпоінт фізично недосяжний для NOWPayments через SSO protection.

---

## B. Git State

| Параметр | Значення |
|---|---|
| Branch | `staging/ai-support-reliability` |
| HEAD | `6561d8b317a74d49c696e028a124d20ad5f638e7` (не змінено, нових комітів немає) |
| Записів у `git status` до етапу | 104 |
| Записів після етапу | 114 (82 modified + 32 untracked) |

Нові файли цього етапу (untracked): `lib/app-url.ts`, `lib/payments/nowpayments-ipn.ts`, `scripts/app-url.test.ts`, `scripts/email-sender-policy.test.ts`, `scripts/webhook-ipn.test.ts`.

Modified цим етапом: `lib/email/resend.ts` (+55/−2), `lib/email/trade-events.ts`, `lib/email/account-credentials.ts`, `lib/certificates/render.ts`, `app/api/webhooks/payment-success/route.ts`, `package.json` (3 нових npm-скрипти), `scripts/email-transport.test.ts` (оновлено тест 3, додано 3b).

Усі початкові 104 записи збережено; `git reset`/`git clean`/commit/push/merge не виконувалися; історію не змінено.

---

## C. Resend

### Встановлена причина 422 (підтверджена ланцюг)

1. `RESEND_FROM_EMAIL` локально **порожній** (значення присутнє, але length 0); у Vercel-скоупах значення замасковане `[SENSITIVE]`, тому фактичне production-значення на рівні конфігурації не могло бути прочитане безпечно.
2. Код: `from: process.env.RESEND_FROM_EMAIL || DEFAULT_FROM` → fallback на **`PFT Challenges <onboarding@resend.dev>`** — це sandbox-відправник Resend.
3. Resend у sandbox-режимі обмежує доставку адресою власника акаунта; будь-який реальний отримувач → **HTTP 422**. Окремо: `RESEND_API_KEY` у prod+preview — sandbox-режим (жива перевірка в 1.12 дала 422 «use our testing email address…»), тобто обмеження діє на рівні ключа навіть із коректним відправником.

Висновок: проблема **двофакторна** — sandbox API key (owner-only) І небезпечний fallback відправника (виправлено в коді). Єдиний спільний транспорт `sendEmail` підтверджено: 24 call-sites, жодних альтернативних транспортів (тест 11 email-transport перевіряє це постійно).

### Виправлення в коді (`lib/email/resend.ts`)

- `isProductionRuntime()`: `NODE_ENV === 'production'` **або** `VERCEL_ENV === 'production'` (покриває і serverless-рантайм, і збірки).
- `resolveSender()`: у production-подібному рантаймі відсутній/порожній `RESEND_FROM_EMAIL` → **FAILED fail-closed**, нуль HTTP-викликів, гучний `console.error`. У dev зберігається поточний fallback на sandbox-адресу (Mailpit та sandbox-флоу не зламані — тести 8/8c/8d продовжують проходити).
- `classifyResendFailure()`: 422 → явний хінт «sandbox/testing restriction — verify a sending domain and configure RESEND_FROM_EMAIL with a non-sandbox API key»; 401/403 → хінт «API key rejected»; інші статуси — попередній формат `Resend <status>: <detail>`. Помилки не містять тіла листа/отримувача (тест 6 email-sender-policy перевіряє відсутність витоку).
- Mailpit-транспорт не змінено (dev-only, loopback, fail-closed у production — усі 19 попередніх контрактів збережено).

### Тести

- `scripts/email-transport.test.ts`: 20 тестів PASS (19 попередніх контрактів збережено; оновлено тест 3 — production тепер вимагає налаштований відправник; додано 3b — production без `RESEND_FROM_EMAIL` → fail-closed).
- `scripts/email-sender-policy.test.ts` (новий, 10 тестів): production без/з порожнім `RESEND_FROM_EMAIL` → FAILED без викликів; `VERCEL_ENV=production` теж покривається; production з налаштованим відправником шле точне значення та передає `Idempotency-Key`; dev зберігає sandbox fallback; 422/401/403/500/502 класифікація; SKIPPED без ключа.

### Що потребує owner action (не виконано autonomously)

Верифікація домену + новий non-sandbox ключ + `RESEND_FROM_EMAIL` у production (докладно в K-1). Без цього реальні отримувачі продовжують отримувати 422 — це єдиний спосіб остаточно відновити email.

---

## D. Database Isolation

### Ідентичності

| Середовище | Identity | Стан |
|---|---|---|
| Preview | `DATABASE_URL` присутній (masked), `current_database()` недоступний | **UNVERIFIED** на рівні значення |
| Production | `DATABASE_URL` присутній (masked) | **UNVERIFIED** на рівні значення |
| `pft_dbtest` | credentials відхилені сервером (1.12), відсутні й у 1.13 | **UNREACHABLE** |

### Факти конфігурації (read-only, з 1.12 + перевірено `vercel env pull --environment preview` у 1.13)

- `DATABASE_URL` — scopes production + preview, ризик спільного значення **не знятий** (Vercel не розкриває значення через pull для secret-змінних; це технічна межа безпечного аудиту).
- `DIRECT_URL` — відсутній всюди (не використовується).
- Workers (`workers/trading-orders.ts`, `workers/market-candles.ts`) і cron використовують ті самі scope-набори env — окремих DB-змінних у них немає.
- `NEXT_PUBLIC_APP_URL` — **підтверджено відсутній у preview scope** (env pull у 1.13). Production-only.
- Інші DB-релевантні: `AI_SUPPORT_TEST_DB(+_URL)`, `PAYOUT_CONCURRENCY_TEST_DB(+_URL)`, `OBSERVABILITY_TEST_DB(+_URL)` — локально відсутні.

### Висновок про ізоляцію

**Ізоляція Preview/Production НЕ ПІДТВЕРДЖЕНА** на рівні значень. Кодова база не має небезпечних fallback (жодного альтернативного DB URL у коді; Prisma клієнт єдиний, ініціалізується лише з `DATABASE_URL`), але технічно можливе спільне значення змінної залишається головним архітектурним ризиком. Виправлення — owner-only (K-2): окремі значення `DATABASE_URL` для production і preview скопів.

### Залишкові ризики

- Помилкові тестові записи в Production доки не розблоковані тестовим середовищем — захищено fail-closed гейтом (E), але сам гейт без валідного `pft_dbtest` URL неактивний.
- будь-який майбутній скрипт, що читає `DATABASE_URL` безпосередньо, у Preview-рантаймі використає те саме значення, що й Production, доки не виконано K-2.

---

## E. Test Database (`pft_dbtest`)

- Локальні credentials: відхилені сервером (диагностика 1.12: TCP/TLS OK, відмова на рівні auth; db name в URL — `neondb`, не `pft_dbtest`). У 1.13 змін не було — `.env.local` не містить `OBSERVABILITY_TEST_DB_URL`.
- Гейт (`scripts/test-db-guard.ts` + `scripts/observability-db-gate.ts`): **fail-closed підтверджено** власними тестами в загальному прогоні — точний host-allowlist (production-хост жорстко заборонений), обов'язковий db name `pft_dbtest`, `sslmode=verify-full`, жива перевірка `current_database()` перед першим записом, відмова замість fallback.
- **19 DB-gated тестів: 19/19 SKIPPED** з точними причинами (10× «requires OBSERVABILITY_TEST_DB=1 and OBSERVABILITY_TEST_DB_URL for the isolated pft_dbtest database»; 9× «requires PAYOUT_CONCURRENCY_TEST_DB=1 and PAYOUT_CONCURRENCY_TEST_DB_URL (isolated pft_dbtest)»). Не масковано як PASS; очікуваний результат 19/19 PASS після виконання K-3.

---

## F. NOWPayments

### Webhook security / signature verification (завершено локально)

- Сигнатурні хелпери `sortKeysDeep`/`isValidSignature` витягнуто з роута в `lib/payments/nowpayments-ipn.ts` (behavior-preserving; роут імпортує ті самі функції). HMAC-SHA512 за рекурсивно відсортованим JSON — без змін.
- Новий harness `scripts/webhook-ipn.test.ts` — **13 тестів PASS** з *реально підписаними* фікстурами (через сам витягнутий хелпер — перевіряється і хелпер, і роут одночасно):
  - валідний signed PAID → умовне оновлення `where status != 'PAID'` усередині транзакції;
  - invalid signature → 401, нуль звернень до БД; підроблене тіло (підпис іншого тіла) → 401;
  - відсутній secret → 503 fail-closed до будь-яких перевірок;
  - duplicate delivery → 200 `{duplicate:true}` без БД-записів;
  - пізніший FAILED **не може** перезаписати PAID (0 update-викликів);
  - невідоме замовлення → 404 + `releaseWebhookEvent` (провайдер зможе ретраїти);
  - FAILED застосовується лише через умовне оновлення; lost race (count 0) → звіт «still PAID»;
  - проміжні статуси (waiting) — only acknowledge, без апдейтів;
  - 400 для браку `order_id`/`payment_status` і для invalid JSON.

### Idempotency

`webhookEventId(sha256(rawBody))` + claim/release модель — підтверджено тестами 2/6/8. Креденшел-fallback `NOWPAYMENTS_IPN_SECRET || NOWPAYMENTS_IPN_KEY` залишено як є (behavior-preserving; задокументовано в 1.12).

### Preview SSO limitation / Unverified

Живий зовнішній Preview-вебхук залишається **UNVERIFIED**: (1) deployment protection (SSO) блокує зовнішні запити; (2) у preview-скоупі немає `NOWPAYMENTS_IPN_SECRET` → навіть при bypass роут відповідав би 503 fail-closed (коректно). Снімати SSO або використовувати Production secret у Preview заборонено — обидва варіанти відкинуті; рішення в K-4. Локальні/mock-перевірки (вище) завершено повністю.

---

## G. Preview URL

- **Підтверджено (env pull):** `NEXT_PUBLIC_APP_URL` відсутній у preview scope → попередня логіка (`|| DEFAULT_APP_URL`) давала б Preview-листам посилання на Production-домен.
- **Виправлення:** спільний `lib/app-url.ts` з детермінованою резолюцією (без сніфінгу заголовків): явний `NEXT_PUBLIC_APP_URL` → у preview-рантаймі `https://$VERCEL_URL` (URL deployment'а) → канонічний Production URL. Trailing-slash normalization збережено.
- **Делегування:** `lib/email/account-credentials.ts` і `lib/certificates/render.ts` тепер імпортують/ре-експортують `appUrl()` з єдиного модуля; усі споживачі (webhook-роут, `checkout`, `accounts/[id]/reset/checkout`, `password-reset`, `breach-notice`, certificate `verifyUrl`) автоматично отримують середовищно-коректні посилання. Exported імена збережено — жодних змін у call-sites.
- **Тести:** `scripts/app-url.test.ts` (7 тестів PASS): явний var перемагає скрізь; preview → `VERCEL_URL`; порожній var → теж `VERCEL_URL`; preview без `VERCEL_URL` → дефолт; production ігнорує `VERCEL_URL` (немає leak у production); без конфігурації → дефолт; обидва файли-делегат позбавлені власного `DEFAULT_APP_URL`.
- OAuth redirect-и не змінювалися (OAuth вимкнений; при майбутньому включенні `NEXT_PUBLIC_APP_URL` у preview — частина K-5).

---

## H. OAuth

- Поточний стан: **безпечно вимкнений.** `providers: googleClientId && googleClientSecret ? [Google(...)] : []` — без credentials список порожній; email/password auth від цього не залежить (перевірено regression-набором auth-тестів — 0 нових fail).
- Небезпечних fallback немає: secret-ланцюг `AUTH_SECRET || TRADER_SESSION_SECRET || ADMIN_SESSION_SECRET` — усі три скопи мають `TRADER_SESSION_SECRET` (з 1.12 env ls), тому JWT-підпис завжди валідний і стабільний.
- Callback handling: `signIn` жорстко відкидає не-Google провайдери, не верифіковані email, staff/archived акаунти; `jwt`-callback щозапитово перевіряє `tokenVersion`/`archivedAt` (ревокція працює навіть для виданих токенів).
- Частково налаштований стан (тільки ID без SECRET) → провайдер просто не активується; помилок у runtime немає.
- Credentials не створювалися; Production OAuth settings не змінювалися. Для майбутнього включення потрібні: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (+ redirect URIs у Google Console) — рішення K-8/OPTIONAL.

---

## I. Regression

| Перевірка | Результат |
|---|---|
| Повний прогін `node --experimental-test-module-mocks --import tsx --test scripts/*.test.ts` | **631 тести / 550 PASS / 0 FAIL / 81 SKIP**, exit 0 |
| Бейзлайн 1.12 | 600 / 519 / 0 / 81 |
| Дельта | **+31 тести, +31 PASS, skips без змін** (7 app-url + 10 email-sender-policy + 13 webhook-ipn + 1 email-transport 3b) — пояснена, необґрунтованих skips немає |
| SKIP склад (без змін) | 72 observability-gated внутрішні skips + 9 payout-concurrency gated |
| `npm run test:db:gated` окремо | 19/19 SKIPPED (причини в E) |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | 0 errors, 63 warnings (pre-existing у `lib/stores/*` тощо; жодного з файлів цього етапу) |
| `npx prisma validate` (з DATABASE_URL з `.env.local`) | **valid** (warn про `package.json#prisma` у Prisma 7 — відоме, рішення K-7) |
| `npm run build` (production) | exit 0 |
| `git diff --check` | чисто (лише pre-existing CRLF-попередження) |

Покриття попередніх core-наборів (Admin, Trader, Archive, Finance, Risk Equity, payout, AI Support, auth, rate-limit, email transport, DB gate) — усередині загального прогону, 0 нових failures.

---

## J. Production Safety

- Production environment variables: **не змінювалися** (єдине звернення до Vercel env — read-only `vercel env pull --environment preview`; файл-вивід одразу видалено; значення не друкувалися).
- Production database: **не змінювалася** (жодних з'єднань, DDL/DML, `prisma db push` немає; `prisma validate` — локальна перевірка схеми).
- Production Resend configuration: **не змінювалася** (ключ/домен/відправник не чіпалися; жодних реальних листів не відправлено).
- Production payment configuration: **не змінювалася** (жодних реальних платежів/пейаутів/вебхук-транзакцій; тестовий harness — повністю локальний, з моками).
- Production deployment: **не створювався** (build виконано локально).
- Migrations: **не виконувалися**.
- Git history: **не змінена** (HEAD той самий; комітів немає; усі початкові незакомічені зміни збережено).
- Secrets: не надруковані, не записані в документацію; у командах використано лише масковані metadata та тестові фіктивні значення (`test.invalid`, `ipn-secret-for-tests`).

---

## K. Owner Actions

### CRITICAL

**K-1. Resend: верифікувати домен + non-sandbox ключ + `RESEND_FROM_EMAIL`**
- Проблема: sandbox API key обмежує доставку адресою власника → реальні отримувачі отримують 422; це блокує email-code, forgot-password, credentials-листи, breach/inactivity/risk-нотифікації.
- Що зробити: (1) у Resend Dashboard → Domains → додати домен PFT і пройти DNS-верифікацію (SPF/DKIM); (2) створити **повноцінний (non-sandbox) API key** з доступом до цього домену; (3) замінити `RESEND_API_KEY` у production scope; (4) встановити `RESEND_FROM_EMAIL` = `PFT Challenges <noreply@<верифікований домен>>` у production scope.
- Де: Resend Dashboard + Vercel → Settings → Environment Variables (scope: **production**; для тестування — окремий preview-ключ і preview `RESEND_FROM_EMAIL`).
- Як перевірити: після deploy в preview/request-логах не має 422; контрольний лист на реальну адресу доставлений; у логах `[pft email]` немає «send refused».
- Ризик, якщо не виконати: всі транзакційні листи в Production продовжують падати з 422; нова fail-closed логіка робить відмову **явною** (FAILED + лог) замість мовчазної доставки «в нікуди».

**K-2. Розділити `DATABASE_URL` за Vercel-скопами**
- Проблема: одне значення на production+preview — прев'ю може писати в Production БД; ізоляція не підтверджена на рівні значень (значення замасковані, безпечний read-only аудит це не розкриває).
- Що зробити: (1) створити окрему preview-БД (наприклад, Neon branch від production або окремий endpoint); (2) у Vercel встановити **окреме** значення `DATABASE_URL` для scope preview (та переконатися, що production-значення не є «shared»); (3) після зміни — redeploy preview.
- Де: Vercel → Settings → Environment Variables (scope preview і production окремо).
- Як перевірити: `vercel env pull --environment preview` локально → значення відрізняється від production (перевіряти лише хост/ім'я БД, не друкувати password); у preview-рантаймі `SELECT current_database()` показує preview-БД.
- Ризик, якщо не виконати: будь-який preview-запит, що мутує дані, пишуть у Production; ручні перевірки/демо в Preview змінюють реальні користувацькі дані.

**K-3. Надати валідний `OBSERVABILITY_TEST_DB_URL` для `pft_dbtest`**
- Проблема: локальні credentials відхилені сервером; без валідного URL 19 DB-gated тестів лишаються SKIPPED.
- Що зробити: у Neon Console на **схваленому тестовому ендпоінті** (`ep-icy-king-…`, не production `ep-jolly-resonance`) створити базу `pft_dbtest` і користувача з правами на неї; скопіювати connection string (include `sslmode=verify-full`) в `OBSERVABILITY_TEST_DB_URL` локально + `OBSERVABILITY_TEST_DB=1` (аналогічно `PAYOUT_CONCURRENCY_TEST_DB_URL` для 9 payout-тестів).
- Де: Neon Console → тестовий endpoint; локально `.env.local` або export у shell.
- Як перевірити: `npm run test:db:gated` → 19/19 PASS; гейт самостійно перевірить host/db name/`current_database()` і відмовить при будь-якій невідповідності.
- Ризик, якщо не виконати: DB-рівень логіки (auth-сесії, rate-limit persistence, payout-конкурентність) не має покриття виконанням; ризик регресій залишиться непоміченим до Production.

### HIGH

**K-4. NOWPayments Preview: окремий IPN secret + рішення щодо SSO bypass для вебхук-шляху**
- Проблема: у preview scope немає `NOWPAYMENTS_IPN_SECRET` (→ 503 fail-closed) і зовнішні запити блокує deployment protection.
- Що зробити: (1) у NOWPayments створити окремий IPN secret для preview і встановити `NOWPAYMENTS_IPN_SECRET` у **preview scope** (не копіювати production); (2) вирішити, як відкрити ТІЛЬКИ `/api/webhooks/payment-success` для зовнішніх запитів — наприклад Vercel «Protection Bypass for Automation» або окремий deployment для вебхуків; SSO для всього preview залишити.
- Як перевірити: підписана NOWPayments-фікстура (або локальний `scripts/webhook-ipn.test.ts` як референс формату) → 200/401/503 відповідно до вмісту; невалідний підпис → 401.
- Ризик: без цього реальний NOWPayments-вебхук у Preview неперевірений (UNVERIFIED) — інтеграційний шлях payment→provisioning вперше виконається тільки в Production.

**K-5. `NEXT_PUBLIC_APP_URL` у preview scope**
- Проблема: відсутній у preview; кодовий fallback на `https://$VERCEL_URL` (1.13) працює, але явне значення чистіше (OAuth/KYC callback-и, консистентність після redeploy).
- Що зробити: встановити `NEXT_PUBLIC_APP_URL` = URL preview deployment'а у scope preview.
- Ризик: без значення — fallback; з невірним значенням — посилання листів/redirect-и прев'ю вели б не туди (fallback усуває найгірший випадок — посилання на Production).

### OPTIONAL

**K-6.** (об'єднано з K-7/K-8 нижче за пріоритетом власника)

**K-7. Prisma 7 major upgrade decision** — CLI попереджає: `package.json#prisma` deprecated у Prisma 7 (потрібен `prisma.config.ts`). Поточна версія 6.19.3 працює; апгрейд — окреме рішення.

**K-8. OAuth credentials** (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` + Google Console redirect URIs) — для майбутнього включення; зараз OAuth безпечно вимкнений і не блокує жоден флоу.

**K-9. Тестові акаунти Admin/Trader** для живих workflow-перевірок (перенесено з 1.12).

---

## L. Фінальний висновок (українською)

**Що тепер працює:** увесь кодовий бік інфраструктури приведено в порядок і покрито тестами. Email-система більше не може мовчки відправляти листи з «пісочниці» — у production вона або шле з правильного налаштованого відправника, або свідомо відмовляється і пише в лог чітку причину. Платіжний вебхук NOWPayments перевірено повним локальним іспитом з реальними криптографічними підписами: підроблені запити відхиляються, дублікати не подвійно оплачуються, а пізні «failure»-повідомлення не можуть зіпсувати вже оплачене замовлення. Посилання в листах для прев'ю-середовища тепер ведуть на прев'ю, а не на продакшн-домен.

**Що виправлено:** небезпечний fallback відправника в Resend; відсутність класифікації помилок Resend; неправильні URL у прев'ю-листах; відсутні ключі ідемпотентності для листів про закриття угод і news-порушення. Додано 31 новий тест; повна регресія 631/550/0 FAIL/81 SKIP, TypeScript, ESLint, Prisma-валідація та production-збірка — чисто. Нічого в Production не змінено, історію Git не чіпано, усі ваші попередні незакомічені зміни на місці.

**Що залишилося (тільки ваші дії):** чотири речі, які я не мав права робити сам. (1) Resend: верифікувати домен і замінити sandbox-ключ — без цього реальні клієнти досі не отримують листів, код тепер чесно про це повідомляє. (2) Розділити `DATABASE_URL` між Production і Preview — це головний архітектурний ризик: доки значення спільне, прев'ю теоретично може писати в вашу бойову базу. (3) Створити тестову базу `pft_dbtest` з валідними credentials — тоді 19 заблокованих DB-тестів запустяться (очікую 19/19 PASS). (4) Вирішити питання NOWPayments у прев'ю (окремий секрет + доступ для вебхука).

**Чи безпечна ізоляція середовищ:** на рівні коду — так (немає небезпечних fallback, тестовий гейт жорстко fail-closed); на рівні значень — **ні, не підтверджена**, і це вирішується лише дією K-2.

**Чи відновлений email:** частково. Код готовий і безпечний; остаточне відновлення доставки залежить від K-1 (власника).

**Чи виконані DB-тести:** ні — чесно SKIPPED через відсутність доступу до `pft_dbtest` (K-3).

**Чи готовий PFT до наступного етапу:** так, із застереженням. Кодова база стабільна, регресія зелена, ризики точно локалізовані і мають покрокові інструкції. Після виконання K-1–K-4 статус можна підняти до PASS без додаткових кодових змін.
