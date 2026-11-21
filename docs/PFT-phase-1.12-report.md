# PHASE 1.12 — Final Preview Validation, Admin Archive, Database Isolation, Security Hardening

Дата: 2026-11-12 · Гілка: `staging/ai-support-reliability` · HEAD: `6561d8b317a74d49c696e028a124d20ad5f638e7`

---

## A. Executive Summary

**Загальний статус: PARTIAL** (без Production-ризиків; головні невиконані пункти — через відсутність credentials/підтвердження середовища, не через дефекти коду).

**Завершено:**
1. **Admin Archive (soft archive)** — серверне блокування архівованих акаунтів реалізовано на всіх торгових шляхах (engine, workers, crons), UI оновлено, додано 5 regression-тестів (5/5 PASS). Hard-delete неможливий за дизайном (append-only ledger trigger + RESTRICT FK); idempotentність гарантована.
2. **Dependency security** — 4 з 7 вразливостей (6 advisory-записів npm audit) **виправлено** патченими версіями в межах існуючих major-діапазонів: `body-parser 2.4.0`, `qs 6.17.1`, `fast-uri 3.1.9`, `ip-address 10.7.6`. Оновлено обидва lockfile-и (tracked `package-lock.json` через npm `overrides`, `pnpm-lock.yaml` через pnpm `overrides`). Решта 3 записів — один і той самий ланцюг `prisma → @prisma/config → deepmerge-ts` (GHSA-ggr8-5vv4-36mx), fix = мажорний prisma 7.10.1 → рішення власника.
3. **Rate-limit runtime** — живі контрольовані запити до Preview: `email-code`, `forgot-password`, payment webhook — поведінка безпечна, витоків існування користувачів немає. Prisma `23502` — **не знайдено** у доступних логах.
4. **Preview ENV / інтеграції** — повна таблиця змінних і статусів; cron-ендпоінти fail-closed (5/5 роутів), webhook fail-closed (жива перевірка), email-код route чистить рядок при фейлі відправки.
5. **Regression** — 600 core-тестів: **519 PASS / 0 FAIL / 81 SKIP** (дельта від 583/511/72 пояснена: +8 нових моїх тестів, +9 skip-ів від включення gated `payout-concurrency.test.ts` у пакетний прогін). tsc / ESLint / prisma validate / production build / `git diff --check` — все чисто.

**Не завершено (blockers):**
1. **CRITICAL: ізоляція Preview/Production БД не підтверджена однозначно** — `DATABASE_URL` має спільний scope Production+Preview одним значенням.
2. **19/19 DB-gated тестів не виконані** — єдиний доступний креденшел серверно відхиляється (застарілий); `pft_dbtest` підтвердити неможливо.
3. **Live Admin/Trader workflows та mobile viewport — UNVERIFIED** (немає credentials).
4. **Знайдено новий blocker поза очікуваннями: Resend ключ у sandbox-режимі** — відправка листів реальним користувачам падає (422) **включно з Production**.

**Головні ризики (top-3):** ізоляція БД (CRITICAL), sandbox Resend (blocker відправок), відкладений мажорний prisma-апгрейд (3 high audit-записи).

Production не змінювався: жодного деплою, жодних env-змін, жодних DDL/DML, жодних фінансових операцій.

---

## B. Git State

- Гілка: `staging/ai-support-reliability`; HEAD: `6561d8b` (не змінювався).
- **Commit/push/merge/reset/clean/branch-switch: НЕ виконувались** (0 комітів).
- Робочий стан: ~103 записів modified/untracked (старт фази — 97; приріст = файл цієї фази + нові тести + lockfile-и).
- Tracked deletion `middleware.ts` / новий `proxy.ts` — стан PHASE 1.11 (не чіпалось).

**Файли, змінені саме в PHASE 1.12:**

| Файл | Що змінено |
|---|---|
| `lib/trading/engine.ts` | `archivedAt` у Working + `isTradingStatus(status, archivedAt)` — defense-in-depth: архівований акаунт ніколи не торговий (13 точок виклику замінено на `tradingAllowed(w)`) |
| `lib/trading/repository.ts` | `archivedAt` у `AccountRow` + SELECT-мапінг (з `withPrismaBook` include) + mock-акаунт; `activeTradingTargets` — фільтр `archivedAt: null` у positions/orders запитах workers |
| `app/api/cron/trading/route.ts` | findMany синхронізованих акаунтів — `archivedAt: null` |
| `lib/trading/passing.ts` | `evaluateActiveAccountsPassing` — `archivedAt: null` (арахівований не проходить фази) |
| `lib/accounts/inactivity.ts` | inactivity-breach сканер — `archivedAt: null` (не перезаписує ARCHIVED → BREACHED) |
| `components/dashboard/accounts-view.tsx` | фільтр «Current» (архівовані поза поточним набором), чіп «Archived — trading disabled» замість «Open in Terminal» |
| `scripts/archive-enforcement.test.ts` | NEW — 5 тестів контракту архівування |
| `scripts/auth-rate-limit-route.test.ts` | NEW — 3 route-тести rate-limit (моки, без БД) |
| `package.json` | `overrides` (4 патчені пакети) + скрипти `test:archive`, `test:auth-routes` |
| `package-lock.json` (tracked) | оновлено `npm install --package-lock-only` з overrides — **це lockfile, яким керуються поточні Vercel-деплої** |
| `pnpm-workspace.yaml` / `pnpm-lock.yaml` (untracked) | ті самі overrides для майбутньої pnpm-міграції |
| `docs/PFT-phase-1.12-report.md` | цей звіт |

Захищені мітки: prebuild-скрипти `scripts/bootstrap-production.cjs` (guard `PFT_BOOTSTRAP=1`) та `scripts/migrate-stress-test.cjs` (guard `PFT_STRESS_MIGRATIONS=1`) — локальні білди не виконували жодних БД-операцій (перевірено: обидва виходять no-op без прапорців).

---

## C. Admin Archive

**Початкова проблема (з PHASE 1.11):** потрібно довести, що архівований акаунт заблокований на сервері, а не лише прихований в UI, і що затверджена поведінка (soft archive, збереження історії/ledger/payout/audit, інші акаунти не зачеплені, idempotentність) дотримана на всіх шляхах.

**Затверджена поведінка vs реалізація:**

| Вимога | Статус | Як реалізовано |
|---|---|---|
| Soft archive, не видалення | так | `archiveAccount` пише `status='ARCHIVED'` + `archivedAt` атомарно під row-lock; жодного delete у шляху; ledger — append-only trigger, FK RESTRICT |
| Зникає зі списку активних | так | Dashboard: category `archived`; UI-фільтр «Current» виключає архівовані з базового виду, окремий таб «Archived / Breached» залишає доступ до історії |
| Не може відкривати нові угоди | так | Engine `tradingAllowed(w)` = `archivedAt == null && (ACTIVE|FUNDED)` — перевіряється у placeMarketOrder/placePendingOrder/modify/processPendingOrders/sync/protective (13 точок) |
| Серверне блокування навіть при застарілому статусі | так | Подвійний захист: `status` + `archivedAt` (тест: «archivedAt alone blocks trading even when status still looks ACTIVE» PASS) |
| Workers/crons не торгують архівованим | так | `activeTradingTargets` (worker), cron-trading findMany, passing-оцінка, inactivity-сканер — всі з `archivedAt: null` |
| Історія/ledger/payout/audit збережені | так | Hard-delete неможливий (дизайн БД); admin-роут не містить delete-операцій (перевірено статично тестом) |
| Інші акаунти трейдера не зачеплені | так | Архівування точкове (по одному акаунту); sibling-логіка не змінена (тест: «archiving one account leaves the trader's other account tradable» PASS) |
| Audit log | так | `ACCOUNT_ARCHIVED` з `actorId`, `reason`, метаданими — один рядок на дію |
| Повторне архівування безпечне | так | `already_archived` ранній вихід ДО мутації (тест: друга спроба не пише update і не дублює audit PASS) |
| ADMIN-only | так | `DELETE /api/admin/accounts/[id]`: `requireAdmin()` + `session.role !== 'ADMIN' → 403`; трейдерського/self-service шляху архівування не існує (перевірено grep: виклики лише в 2 admin-роутах) |
| Блокери перед архівуванням | так | 409 з переліком: OPEN_POSITIONS / PENDING_PAYOUTS (PENDING+APPROVED) / UNRESOLVED_FX; pending orders скасовуються атомарно в тій же транзакції |

**Тести:** `npm run test:archive` — **5/5 PASS**. `test:auth-routes` (route-моки rate-limit) — **3/3 PASS**.

**UNVERIFIED (чесно):** живе архівування з реальними Admin credentials на Preview — не виконано (немає credentials); поведінка покрита unit-контрактом і статичними перевірками.

Різниця операцій підтверджена: single-account archive (`/api/admin/accounts/[id]`) ≠ user deactivation (`archiveUserAccounts` у `/api/admin/users/[id]`) ≠ видалення профілю/даних (не існує).

---

## D. Database Isolation

**Що встановлено:**

1. **Vercel:** `DATABASE_URL` — одна змінна зі scope `Production, Preview` (created 3d ago). Поточний Production deployment — 13 днів старий → він побудований зі **старим** значенням змінної; активний Preview отримав нове. Наслідок: наступний **Production deployment мовчки переключиться на те значення, яким сьогодні користується Preview** — окрема точка ризику.
2. `DIRECT_URL` відсутній у Vercel; Prisma datasource має лише `url = env("DATABASE_URL")` (без `directUrl`/`shadowDatabaseUrl`). Альтернативних БД-URL і fallback-логіки в коді немає (grep: `VERCEL_ENV` використовується лише в `lib/ops/database-identity.ts` для класифікації, не для переписування URL; identity-перевірка admin-diagnostics — read-only).
3. Непрямі свідчення, що Preview і Production — **різні датасети** (як і в 1.11): `/api/pricing` → Preview `0` цін, Production `15`; перші event-ID `/api/market/news-calendar` різні. Проте це не доводить фізичної ізоляції (можливо, просто не засіяна окрема БД).
4. Точна ідентичність Preview БД — **UNVERIFIED**: значення змінної «sensitive», `vercel env pull` для деплойменту значення не віддає (failed), витягувати secrets не дозволено.
5. `FORBIDDEN_TEST_DATABASE_URLS = [/ep-jolly-resonance/i]` — production-подібний endpoint жорстко заборонений для тестів; gate тримався fail-closed на кожному кроці спроби.

**Критерії з §3.3:**

| Питання | Відповідь |
|---|---|
| Яка БД у Preview | UNVERIFIED (sensitive value недоступна) |
| Яка БД у Production | UNVERIFIED точно; 13-денний деплоймент живе зі значенням, зафіксованим на момент його збірки |
| Фізична/логічна ізоляція | **НЕ ПІДТВЕРДЖЕНА** |
| Чи може Preview писати у Production | Немає доказів ні «так», ні «ні» |
| Workers/crons правильне середовище | Окремих URL немає — той самий `DATABASE_URL` того середовища, де виконуються |
| Небезпечний fallback на Production URL | Не знайдено в коді |

**Вердикт: CRITICAL BLOCKER залишається** (спільний scope однієї змінної = логічно НЕ розділені). Виправлення вимагає окремого дозволу власника: розділити `DATABASE_URL` на окремі значення per-scope у Vercel + звірка з Neon-консоллю.

**`pft_dbtest` identity:** локальний креденшел з `.env.local` — роль `neondb_owner` на branch-хості `ep-icy-king-b4ozchkf…` (сам хост у owner-allowlist гейта), але (а) шлях БД у URL — `neondb`, а не `pft_dbtest`; (б) сервер **відхиляє аутентифікацію** цього креденшелу на всіх варіантах (direct+verify-full, direct+require, pooler; діагностика: TCP/TLS до Neon чисті — ланцюг Let's Encrypt → ISRG Root X1, без перехоплення; відмова — саме credentials). Підтвердити ідентичність неможливо → DB-mutating тести не запускались.

---

## E. DB-gated Tests — усі 19

**Результат: 19/19 SKIPPED (BLOCKED)** — запущені, але без жодного mutative виконання: гейт відмовляє до підключення. Жоден тест не пропущений без причини; жоден не замаскований.

| # | Файл | Тест | Причина |
|---|---|---|---|
| 1–5 | `scripts/gated/auth-login-db.test.ts` | wrong password →401+counter; repeated failures →429+Retry-After; unknown email generic 401; TRADER cannot log into admin desk; correct creds → hardened cookie | `DB writes not authorized: requires OBSERVABILITY_TEST_DB=1 and OBSERVABILITY_TEST_DB_URL for the isolated pft_dbtest database` |
| 6–10 | `scripts/gated/rate-limit-store-db.test.ts` | first increment count=1 non-null updatedAt; second increment atomic; reset removes bucket; expired window restarts; parallel increments lose no counts | те саме |
| 11–19 | `scripts/payout-concurrency.test.ts` | Q2 breach-first; Q9 Case A/B/C; approve-vs-reject; confirm-vs-reject; reject-vs-archive; double reject/confirm; Q5 news hold | `requires PAYOUT_CONCURRENCY_TEST_DB=1 and PAYOUT_CONCURRENCY_TEST_DB_URL (isolated pft_dbtest)` |

Додатково (того ж класу, у core-пакеті): 72 skip-и в `scripts/observability*.test.ts` з причиною `requires OBSERVABILITY_TEST_DB=1…` — це ті самі 72 skip-и PHASE 1.11.

**Механізм захисту від випадкового переключення на Production/Preview** (перевірено): exact-host allowlist (`ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech`), заборона `/ep-jolly-resonance/i`, шлях строго `/pft_dbtest`, TLS строго `verify-full`, live-перевірка `current_database() === 'pft_dbtest'` на ТОМУ Ж клиенті, який виконує тести; помилки без URL/креденшелів.

**Що потрібно власнику:** валідний креденшел `pft_dbtest` (поточний застарілий — сервер відхиляє) у `OBSERVABILITY_TEST_DB_URL`. Після цього `npm run test:db:gated` виконає всі 19 автоматично з identity-перевіркою.

---

## F. Preview Workflows

Preview: `https://pft-app-prod-fm29bhb4k-andripigij-5023.vercel.app` (dpl_9hF6MekQohxnhvbkbySnrhTxqyLc, Ready). **Важлива знахідка:** на Preview увімкнена Vercel Deployment Protection (SSO) — прямі HTTP-запити отримують 401; живі перевірки виконувались через авторизований bypass (`vercel curl`).

**Перевірено реально (live):**

| Область | Результат |
|---|---|
| `/` | рендериться (HTML 184 KB) |
| `/login` | рендериться (HTML 15 KB) |
| `POST /api/auth/email-code` (3× випадкові адреси) | не витікає існування; при фейлі відправки → 503 «Unable to send an email code right now», щойно створений код-рядок **видаляється** (без сміття в БД) |
| `POST /api/auth/forgot-password` | generic `ok:true` незалежно від результату відправки (без витоку) |
| `POST /api/webhooks/payment-success` (без підпису) | fail-closed: «IPN verification is not configured» (503) |
| OAuth | **NOT CONFIGURED** — `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` відсутні в усіх scopes Vercel; Google-провайдер вимкнений умовно в коді. Email-code — єдиний живий auth-шлях |

**UNVERIFIED (чесно):**
- Реєстрація/верифікація email кінцем-в-кінці (Resend у sandbox — див. розділ I);
- Trader dashboard / terminal / account selection / history / заблоковані дії на архівованому акаунті в UI (немає тестових credentials);
- Admin Desk / users / accounts / archive / audit log / payout review (немає Admin credentials);
- Mobile viewport усіх інтерфейсів (немає залогіненого браузерного доступу);
- Живий 429 від per-IP ліміту (не провокував 30 запитів навмисно: це створило б 30 записів у Preview БД та 30 звернень до Resend; ліміт-прошивка перевірена unit-тестами 3/3).
- Логи глибше 30-хвилинного вікна: Vercel CLI стабільно повертає 0 записів для `--since/--until` довших вікон (обмеження CLI/плану) — свіп зроблено в межах доступного.

Жодних заяв про live-перевірку того, чого не було, не робиться.

---

## G. Rate-limit + Runtime

**Перевірені endpoints:** `/api/auth/email-code` (per-IP 30/15min, жива поведінка), `/api/auth/forgot-password` (per-IP 20/15min), payment webhook (контекст).

**Знайдено/підтверджено:**
- IP extraction: `clientIp(request)` з trusted Vercel-заголовків; окремі IP → окремі бакети (unit 3/3, включно з різними заголовками).
- Durable storage лімітів — БД-залежний (`rate-limit-store`) — **UNVERIFIED live** (той самий gated-блокер, тести 6–10 вище).
- Логи (30m-вікно після контрольованого трафіку): **0× Prisma 23502**, 0 null-constraint, 0 unhandled exceptions, 0 failed transactions, 0 rate-limit storage errors. Зареєстровані помилки — лише очікувані fail-closed події (див. нижче).
- Причина 503 email-code — **Resend 422 «Invalid `to` field… use our testing email address»** → ключ у sandbox/test режимі (див. I). Це не дефект маршруту.
- Нових 23502 від нових полів/account lifecycle/Admin Archive не виявлено (ні в логах, ні в код-рев'ю: всі нові поля мають дефолти/nullable, archived-шляхи не видаляють колонки).

**Regression-тести додано:** `scripts/auth-rate-limit-route.test.ts` — email-code/forgot-password 429-before-send, Retry-After, роздільні бакети по IP (3/3 PASS).

---

## H. Dependency Audit — 7 записів npm audit (4 High + 3 Moderate → post-fix: 3 High)

Фіксація: npm `overrides` у `package.json` (+ оновлений tracked `package-lock.json`, яким керуються поточні Vercel-деплої) + ті самі overrides у `pnpm-workspace.yaml`/`pnpm-lock.yaml`. Без `audit fix --force`, без majors, без видалень. Перевірено після змін: tsc, ESLint, build, 600 тестів.

| # | Пакет | Встановлено | Severity | Advisory | Шлях | Deployment surface | Disposition |
|---|---|---|---|---|---|---|---|
| 1 | `body-parser` | 2.3.0 | High | GHSA-27r3-jxmh-p828 / CVE-2026-111181 (DoS: trailing bytes після стиснутого body) | `qrcode → express → body-parser` | express не використовується як сервер застосунку (транзитивний optional peer qrcode) | **FIXED → 2.4.0** |
| 2 | `qs` | 6.16.0 | Moderate | GHSA-6pq8-jhm2-2vcw / CVE-2026-110816 (uncaught TypeError, arrayFormat comma) | `express → qs` | той самий транзитивний шлях | **FIXED → 6.17.1** |
| 3 | `fast-uri` | 3.1.8 | Moderate | GHSA-333x-w4r6-6crp (scheme injection), GHSA-w74x-v6f9-j3xg (scheme spoofing), GHSA-wjr9-j795-jxcr (host confusion) | `shadcn → @dotenvx/dotenvx → conf → ajv → fast-uri` | dev/CLI (shadcn-тул), не в server bundle | **FIXED → 3.1.9** (одна версія закриває всі 3 advisory) |
| 4 | `ip-address` | 10.7.3 | Moderate | GHSA-rxp7-6hxx-x8q5 / CVE-2026-111997 (ReDoS на zone identifier) | prod: `@google/genai → @modelcontextprotocol/sdk → express-rate-limit → ip-address`; dev: `shadcn → socks → ip-address` | ReDoS-патерн у MCP/раз-ліміт шляху — обмежений | **FIXED → 10.7.6** (обидва шляхи) |
| 5 | `deepmerge-ts` | 7.1.5 | High | GHSA-ggr8-5vv4-36mx (stack exhaustion на рекурсивному merge) | `prisma → @prisma/config → deepmerge-ts` | лише CLI/конфіг-завантаження Prisma; **не в server runtime bundle** деплойменту | **NOT FIXED — NEEDS MANUAL DECISION** (patched у prisma 7.10.1 — мажорний upgrade; ризикований auto-апгрейд заборонено бріфом). **NOT EXPLOITABLE IN CURRENT DEPLOYMENT** |
| 6 | `@prisma/config` | 6.19.3 | High | той самий ланцюг (позначка утиліти audit) | `prisma` | CLI | **NOT FIXED — NEEDS MANUAL DECISION** |
| 7 | `prisma` | 6.19.3 (direct dev) | High | той самий ланцюг | direct | CLI/build | **NOT FIXED — NEEDS MANUAL DECISION**: оновлення до 7.10.1 (major) потребує окремого вікна регресії |

Пост-фікс стан: `npm audit --omit=dev` → **3 High** (записи 5–7, той самий корінь); `pnpm audit --prod` → **1 High** (deepmerge-ts; body-parser/qs у pnpm-дереві взагалі відсутні — pnpm не встановлює optional peer express). Пріоритет: prisma 7 upgrade як окреме рішення власника.

---

## I. Preview ENV та інтеграції

(значення секретів не показувались; статуси з `vercel env ls` + живих перевірок)

| Змінна/інтеграція | Scopes у Vercel | Статус для Preview | Примітка |
|---|---|---|---|
| `DATABASE_URL` | Production, Preview (одне значення) | CONFIGURED | Ізоляція UNVERIFIED — CRITICAL BLOCKER (розділ D) |
| `DIRECT_URL` | — | NOT REQUIRED | datasource без directUrl; спостереження: міграції йдуть через guard-скрипти, пулінг Neon — окремий пункт для власника |
| `NEXT_PUBLIC_APP_URL` | Production | **MISSING у Preview** | fallback у коді = `https://pft-app-prod.vercel.app` → листи/сертифікати/KYC-callback з Preview вказують на prod-домен |
| `TRADER_SESSION_SECRET` | Prod, Preview, Dev | CONFIGURED | |
| `ADMIN_SESSION_SECRET` | Prod, Preview | CONFIGURED | Admin log-in на Preview забезпечений секретом |
| `ADMIN_BOOTSTRAP_PASSWORD`, `RISK_BOOTSTRAP_PASSWORD` | Production | NOT REQUIRED у Preview (build-guard) | |
| `CRON_SECRET` | Production | NOT REQUIRED у Preview | Усі 5 cron-роутів fail-closed: без секрету → 401 усім (перевірено код 5/5) |
| Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) | Prod, Preview | **CONFIGURED, але НЕПРАВИЛЬНИЙ РЕЖИМ** | Живий 422: ключ у **sandbox** — надсилає лише на «testing email» акаунта. **Реальні листи користувачам падатимуть і в Production** — owner-action |
| NOWPayments (IPN/API/payout creds) | Production only | MISSING у Preview | Preview webhook fail-closed 503 (live: так); секрет не вигадувався, Production-секрет не підставлявся. Додатково: SSO-protection Preview блокує provider-вебхуки фізично |
| Google OAuth (`AUTH_GOOGLE_ID/SECRET`, `AUTH_SECRET`) | — | **MISSING у всіх scopes** | Провайдер вимкнений умовно; email-code — основний шлях. Додати = owner decision |
| DIDIT (API key / workflow ID / webhook secret) | всі scopes | CONFIGURED | fail-safe при відсутності — в коді; live KYC не перевірявся (credentials) |
| NVIDIA (`API_KEY/BASE_URL/MODEL`) | Preview | CONFIGURED | AI-support diagnostics на Preview |
| GEMINI (`API_KEY/MODEL`) | Prod, Preview | CONFIGURED | |
| `NEXT_PUBLIC_APP_URL` fallback у коді | — | видно | див. вище |

Інтеграційний висновок: жодна інтеграція не приймає дані без перевірки підпису/секрету; поведінка при відсутності credentials — безпечна (503/401/вимкнений провайдер), підтверджено живими запитами там, де було можливо.

---

## J. Regression (повний прогін)

| Перевірка | Результат | Порівняння з PHASE 1.11 |
|---|---|---|
| Core test batch (`scripts/*.test.ts`, incl. нові) | **600 tests: 519 PASS / 0 FAIL / 81 SKIP / 0 cancelled** | 583/511/72/0. Дельта: **+8 PASS** = мої нові тести (5 archive + 3 auth-routes); **+9 SKIP** = `payout-concurrency.test.ts` (9 gated-тестів) тепер у пакеті (у 1.11 рахувались окремо у складі «19 gated»). Розкладка 81 skip: 72 = observability-gated (ідентично 1.11), 9 = payout-concurrency-gated. Регресій немає |
| `test:archive` (новий) | 5/5 PASS | — |
| `test:auth-routes` (новий) | 3/3 PASS | — |
| `test:db:gated` (19) | 19/19 SKIPPED — BLOCKED (розділ E) | без змін |
| TypeScript (`tsc --noEmit`) | чисто | без змін |
| ESLint | 0 errors, 63 warnings (попередні, у файлах цієї фази — 0 нових) | без змін |
| `prisma validate` | «schema is valid» | без змін |
| Production build (`npm run build`; prebuild-guard no-op) | успішно, Proxy (Middleware) зареєстрований | без змін |
| `git diff --check` | clean (лише репозиторні CRLF-попередження autocrlf — не whitespace-помилки) | без змін |
| `npm audit --omit=dev` | 4H+3M → **3H** (лише prisma-мажорний ланцюг) | покращено |

---

## K. Remaining Blockers

| # | Blocker | Причина | Вплив | Що потрібно | Owner action? |
|---|---|---|---|---|---|
| 1 | **CRITICAL: ізоляція Preview/Production БД не підтверджена** | `DATABASE_URL` — одна змінна, scope Prod+Preview, одне значення; sensitive-значення недоступне для читання | Ризик записів Preview у Production (не доведений в обидва боки); наступний prod-деплоймент отримає поточне preview-значення URL | Власник: звірка в Neon-консолі; за окремим дозволом розділити змінну per-scope у Vercel | **Так — окремий дозвіл** |
| 2 | 19 DB-gated тестів не виконані | Локальний креденшел застарілий (сервер відхиляє auth); у URL БД `neondb` ≠ `pft_dbtest` | Dur rate-limit store / auth-login / payout-concurrency інваріанти не перевірені живою БД | Валідний `OBSERVABILITY_TEST_DB_URL` для `pft_dbtest`; тоді `npm run test:db:gated` виконає 19/19 з identity-перевіркою | **Так** |
| 3 | **Resend ключ у sandbox-режимі** | Live 422 «use testing email address…» | **Реальні листи (реєстрація, логін-коди, скидання пароля, breach-нотиси) падають — включно з Production** | Зарахтувати/підтвердити домен відправника у Resend, перевести ключ із sandbox | **Так — високий пріоритет** |
| 4 | `NEXT_PUBLIC_APP_URL` відсутній у Preview | Vercel env | Листи з Preview ведуть на prod-домен | Додати Preview-значення (безпечна зміна, не торкається Production) | Так (безпечно) |
| 5 | NOWPayments IPN secret відсутній на Preview + SSO-protection блокує provider-вебхуки | Vercel env + Deployment Protection | Preview-платіжний флоу неперевірений (webhook недосяжний для NOWPayments) | Додати окремий Preview IPN secret і/або вимкнути protection для шляху webhook — рішення власника | Так |
| 6 | prisma 7 мажорний апгрейд (3 High audit) | Breaking major | CLI/build surface; у runtime bundle відсутній | Окреме вікно: `prisma 6.19.3 → 7.10.1`, повна регресія | Так (рішення) |
| 7 | Live Admin/Trader workflows + mobile viewport | Немає credentials | Ці пункти UNVERIFIED (розділ F) | Тестові облікові записи | Так |
| 8 | Подвійна система lockfile-ів | tracked `package-lock.json` (керує поточними деплоями) + untracked `pnpm-lock.yaml` (міграція) | Ризик розсинхронізації | Власник: обрати канонічний; наразі обидва патчені й синхронні | Так (рішення) |
| 9 | Preview `/api/pricing` повертає 0 цін (Production — 15) | Ймовірно незасіяна окрема Preview БД | Косметика/сідінг Preview | Після розв'язання blocker 1 — засіяти/звірити | Пізніше |

---

## L. Фінальний підсумок власника (просто, українською)

**Що фактично зроблено.** Архівування торгових акаунтів адміністратором тепер працює так, як затверджено: акаунт зникає з активного списку трейдера, але історія, фінансові записи, виплати й журнал залишаються; нові угоди на ньому неможливі **на рівні сервера** (навіть якщо обійти інтерфейс, навіть для фонових процесів і cron-задач); інші акаунти трейдера працюють як працювали; повторне архівування нічого не ламає й не дублює записів у журналі. Додано 8 нових автоматичних тестів на ці правила — усі проходять. З 7 уразливих залежностей 4 виправлені (оновлені безпечні версії, перевірені усіма тестами й білдом); решта 3 — це одна проблема Prisma, для якої потрібне окреме рішення про велике оновлення бібліотеки.

**Що тепер працює.** Повний набір перевірок як у попередній фазі, плюс нове: 600 тестів без жодного падіння, TypeScript, лінтер, перевірка схеми БД і складання production-білду — усе чисто. Живі перевірки Preview підтвердили: сторінки входу і головна відкриваються, запити коду на email і відновлення пароля відповідають коректно й не видають, чи існує адреса, платіжний вебхук відкидає запити без підпису, cron-ендпоінти без секрету відповідають 401.

**Чого не вдалося перевірити — і чому.** (1) Ми досі не можемо довести, що Preview і Production користуються **різними** базами даних: змінна підключення одна й та сама для обох середовищ, а точні значення секретів витягнути неможливо. Це найважливіше відкрите питання. (2) 19 тестів, що пишуть у тестову базу, не виконані: єдиний наявний пароль до тестової бази сервер відхиляє (застарів) — потрібен свіжий від вас. (3) Живі сценарії адміністратора/трейдера в браузері й перевірка на «мобільному екрані» — потрібні тестові логіни.

**Нове, що варто знати негайно.** Під час живої перевірки виявилось, що ключ надсилання листів (Resend) працює у тестовому (sandbox) режимі: листи реальним людям не відправляються. Це стосується **не лише Preview, а й Production** — реєстрація, входи за кодом і відновлення пароля у живих користувачів падатимуть. Рекомендую зробити це найближчим кроком.

**Чи можна переходити до наступного етапу?** Технічно — так, для робіт, що не залежать від цих п'яти речей: ізоляція БД, свіжий тестовий креденшел `pft_dbtest`, домен/ключ Resend, тестові логіни, рішення щодо Prisma 7. Критичних дефектів коду не знайдено; Production не торкнувся (жодного деплою, жодних змін змінних, жодних міграцій), історія Git не змінювалась. Але перед першим новим **Production**-деплоєм пункти «ізоляція БД» і «Resend» треба закрити обов'язково.

---

*Звіт створено в межах PHASE 1.12; усі перевірки read-only або контрольовані; secrets не розкривались.*
