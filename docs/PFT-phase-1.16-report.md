# PHASE 1.16 — PFT Test Database Isolation + DB-Gated Tests Readiness

Дата: 2026-11-13
Статус: **READY FOR OWNER AUTHORIZATION** (умовно — див. критерії K: пункти 1–2 частково залежать від owner-підтвердження фактичних endpoint/branch; усі кодові/планові пункти виконані)
Базис: PHASE 1.15 (BLOCKED), branch `staging/ai-support-reliability`, HEAD `6561d8b` (не змінено), 117 записів у робочому дереві (не змінено).

---

## A. Executive Summary

Етап — аудиторсько-плановий: підключень до БД не було взагалі (ні до `neondb`, ні до `pft_dbtest`). Виконано: повний аудит fail-closed гейта (`scripts/observability-db-gate.ts`, 252 рядки) і всіх трьох gated-файлів, інвентаризація рівно **19 тестів**, інвентаризація руйнівних операцій (знайдено **незахищений масовий `deleteMany` у `prisma/seed.ts`** — задокументовано як ризик), реалізовано опціональний role-pinning hardening (`TEST_DB_EXPECTED_ROLE`, default OFF, +4 тести), підготовлено SQL-план окремої ролі, план ініціалізації схеми без `prisma db push`, таблицю Vercel-ізоляції та одну контрольовану команду запуску.

Регресія: **638 / 557 PASS / 0 FAIL / 81 SKIP** (дельта +4 — пояснена, нові role-pinning тести). tsc 0; ESLint 0 errors; prisma validate valid; gated-набір 19/19 SKIPPED без опт-іну (безпечно); `git diff --check` чисто.

## B. Initial Repository State

| Параметр | Значення | Статус |
|---|---|---|
| Гілка | `staging/ai-support-reliability` | не змінено |
| HEAD | `6561d8b317a74d49c696e028a124d20ad5f638e7` | не змінено |
| Незакомічених записів | 117 (усі збережено) | не змінено |
| `.env` / `.env.production` / `.env.development` | відсутні | — |
| `.env.local` | присутній (єдине локальне джерело) | read-only перегляд, значення не друкувалися |
| `.github/workflows` (CI) | **відсутні** — DB-гварди не перевіряються в CI | задокументовано |
| `prisma/migrations` | **каталогу немає** — схему створено/ведуть без міграцій | критично для плану G |

Джерела конфігурації БД: `.env.local` (`DATABASE_URL` → production `neondb`; `OBSERVABILITY_TEST_DB_URL` та `PAYOUT_CONCURRENCY_TEST_DB_URL` — **відсутні**), Vercel scopes (`DATABASE_URL` — один запис Production+Preview, стан 1.15 не змінився), Prisma `datasource db { url = env("DATABASE_URL") }`.

## C. Database Identity and Isolation

**Механізм гейта** (`scripts/observability-db-gate.ts`) — провірено повністю:

| Захист | Реалізація | Статус |
|---|---|---|
| Окрема змінна, НЕ `DATABASE_URL` | canonical `OBSERVABILITY_TEST_DB(+URL)`, legacy-пари лише з явним opt-in | PASS |
| Автоматичний fallback на `DATABASE_URL` | **неможливий** — доведено тестами: `resolveObservabilityTestDb({OBSERVABILITY_TEST_DB:'1', DATABASE_URL: approved})` → `skip`; `resolveTestDatabaseUrl({DATABASE_URL: approved})` → `null` | PASS |
| Endpoint-перевірка | exact host allowlist: `ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech` (owner-підтверджений з Neon Console: Branch `development`, db `pft_dbtest`) | PASS |
| Production-захист | denylist-regex `/ep-jolly-resonance/i` (production endpoint) + exact allowlist → інші хости відхилені | PASS |
| Назва БД | має бути точно `pft_dbtest` у URL-шляху **і** живому `current_database()` | PASS |
| TLS | fail-closed: `sslmode=verify-full` дописується; будь-який інший/конфліктний sslmode → stop | PASS |
| Жива ідентичність | `assertTestDbIdentity` виконує `SELECT current_database()` на реальному з'єднанні перед будь-яким записом; при невдачі — `assertClientIsTestDb` дисконектить клієнт | PASS |
| Секрети | reason-строки та помилки ніколи не містять URL/credentials (перевірено тестами) | PASS |

**Neon project/branch:** allowlist з одного хосту фактично фіксує конкретний endpoint (ep-icy-king-b4ozchkf) → конкретний Neon project і branch (owner підтвердив: branch `development`). Назви scopes не використовуються як доказ — перевіряються URL + живий `current_database()` (+ тепер опціонально `current_user`).

**Production не використовується harness-ом:** структурно неможливо — жоден шлях не читає Production `DATABASE_URL`; denylist блокує production endpoint навіть якщо хтось підставить його URL; live-check відкидає будь-яку іншу БД. **PASS.**

**Value-level ідентичність `pft_dbtest`: NOT VERIFIED** — валідних credentials немає (`OBSERVABILITY_TEST_DB_URL` відсутній локально і в Vercel); підключення не виконувалося (без дозволу). Це і є наступний owner-крок.

## D. Test Harness Security Audit

**Розподіл 19 тестів:** `scripts/gated/auth-login-db.test.ts` (5) + `scripts/gated/rate-limit-store-db.test.ts` (5) + `scripts/payout-concurrency.test.ts` (9, legacy mode `{legacy:true}` через `PAYOUT_CONCURRENCY_TEST_DB*`).

Спільні механіки, провірені по кожному файлу:

- **Ворота:** усі три резолвлять URL виключно через `resolveObservabilityTestDb` і перед першим записом викликають `assertClientIsTestDb` (live `current_database()`). Без opt-in → skip з точною причиною, жодного з'єднання. **PASS.**
- **`DATABASE_URL` підміна:** auth-login та rate-limit тестів *присвоюють* `process.env.DATABASE_URL = TEST_URL` лише ПІСЛЯ того, як гейт повернув верифікований URL — тобто значення походить із гейта, не навпаки. Payout-тестів використовує URL напряму з гейта. **PASS.**
- **Cleanup:** усі сценарії видаляють рівно власні рядки за scoped-фільтрами (email/id-префікси `phase11045-*`, `p11045:<ts>:` PREFIX, cuid-маркер `pftconc-*`), в `after`-хуках. Без ``deleteMany({})``. **PASS.**
- **Transaction rollback:** payout-тестів використовує транзакції з `SET LOCAL statement_timeout=15000` / `lock_timeout=10000` — це race-тести з явними фіналізованими станами, не rollback-модель; прибирають власні рядки після кожного сценарію. **PASS (відповідність задачі).**
- **Паралельність:** race-сценарії паралельні *усередині* одного тесту на одному з'єднанні; набори тестів серійні (node --test default — послідовні файл-потоки). Повторний запуск безпечний: усі ключі/мітки унікальні за часовою складовою + before-cleanup не залежать від попередніх запусків. **PASS.**
- **Доступ до фінансових таблиць:** payout-тестів пише в `Payout`, `AccountLedgerEntry`, `AuditLog`, `AccountBreachEvent`, `TradeHistory`, `TradingAccount`, `User` — **тільки** тестові рядки з маркерами (`pftconc-*`, `@conc.test`, wallet `conc-test-wallet`), без реальних коштів/переказів. **PASS.**
- **Prisma migrations / `db push` у тестах:** відсутні повністю. **PASS.**
- **Seed-скрипти:** `prisma/seed.ts` — **НЕЗахищений** (див. E). `seed-challenge-pricing.ts`/`seed-instrument-registry.ts` — upsert-only, деструктивності не виявлено.

## E. Destructive Operations Inventory

Grep по всьому `scripts/` + `prisma/`: **жодного `DROP DATABASE/TABLE/SCHEMA`, `TRUNCATE`, raw destructive SQL, `prisma db push`, `migrate reset` у тестах немає** (єдині збіги — текстові assert-и у `finance-core.test.ts` про заборону UPDATE/DELETE на evidence і TRUNCATE-тригер, та коментар у `schema-parity.test.ts`).

**Знайдений ризик (не в тестах, але реальний шлях до БД):**

| Операція | Де | Змінна | Гвард ідентичності | Ризик Production | Оцінка достатності захисту |
|---|---|---|---|---|---|
| Масові `deleteMany()` × 6 (trade, payout, order, auditLog, tradingAccount, user — без фільтра) | `prisma/seed.ts:8–13` | `DATABASE_URL` (напрямку, з `.env.local`/runtime) | **немає** | **ТАК — запуск з Production `DATABASE_URL` очистить фінансові таблиці** | **НЕДОСТАТНЬО.** Рекомендація: додати fail-closed гвард (allow `pft_dbtest`-ідентичність або явний `PFT_SEED=1`), ніколи не запускати проти Production |
| `bootstrap-production.cjs` | `scripts/` | `DATABASE_URL` | гвард `PFT_BOOTSTRAP=1` | опосередкований | достатньо (подвійний opt-in) |
| `migrate-stress-test.cjs` | `scripts/` | `DATABASE_URL` | гвард `PFT_STRESS_MIGRATIONS=1` | опосередкований | достатньо |

`prisma/seed.ts` змінювався **не** в цьому етапі (production-facing файл; зміна — окрема рекомендація власнику, не реалізовано тут).

## F. Dedicated Test Role Plan

**Не виконано жодного GRANT/REVOKE/CREATE ROLE — тільки план SQL** для Neon SQL Editor (поточна роль `neondb_owner`):

```sql
-- 0. (у pft_dbtest-контексті Neon Console; роль без CREATEDB, без членства у neondb_owner)
CREATE ROLE pft_test_init  LOGIN PASSWORD '<генерувати у Neon / надійний менеджер>';
CREATE ROLE pft_test_runtime LOGIN PASSWORD '<генерувати у Neon / надійний менеджер>';

-- 1. Роль ініціалізації схеми: володіє ТІЛЬКИ pft_dbtest
REVOKE ALL ON DATABASE neondb FROM pft_test_init;
GRANT CONNECT ON DATABASE pft_dbtest TO pft_test_init;
GRANT ALL ON SCHEMA public TO pft_test_init;
ALTER DATABASE pft_dbtest OWNER TO pft_test_init; -- володіння схемою => DDL (migrate deploy) тільки тут

-- 2. Роль тестового запуску: DML-only
REVOKE ALL ON DATABASE neondb FROM pft_test_runtime;
GRANT CONNECT ON DATABASE pft_dbtest TO pft_test_runtime;
GRANT USAGE ON SCHEMA public TO pft_test_runtime;
-- після ініціалізації схеми:
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public FOR ROLE pft_test_init IN DATABASE pft_dbtest
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
-- (послідовності, якщо з'являться: GRANT USAGE, SELECT ON ALL SEQUENCES ...)

-- 3. Гарантія ізоляції: обидві ролі не мають жодних прав у neondb
REVOKE ALL ON DATABASE neondb FROM pft_test_init, pft_test_runtime;
```

Відповідь на питання D-розділу брифінгу:
- права для міграцій: `pft_test_init` (DDL-володар `pft_dbtest`, ніяких прав на `neondb`);
- права для тестів: `pft_test_runtime` (SELECT/INSERT/UPDATE/DELETE у `pft_dbtest`, без DDL);
- ролі відокремлені: так, ініціалізація ≠ виконання;
- доступ до `neondb`: **явно відкликано** обом ролям (REVOKE ALL ON DATABASE neondb);
- обмеження лише тестовою БД: так — роль створюється без CREATEDB/CREATEROLE, CONNECT лише на `pft_dbtest`, володіння тільки `pft_dbtest`.

**Інтеграція з гейтом:** `TEST_DB_EXPECTED_ROLE=pft_test_runtime` (новий опціональний hardening 1.16) змушує `assertTestDbIdentity` додатково перевірити живий `current_user()` — якщо з'єднання встановлено не під призначеною роллю, тести стопаються. Default OFF — без env-змінної поведінка не змінюється (зворотна сумісність доведена тестами).

## G. Schema and Migration Initialization Plan

Факти: `prisma/migrations` **не існує**; схему фактично створено історично (без міграцій). `prisma db push` **не є затвердженим способом** (заборонений без окремого дозволу). Тому безпечний шлях:

1. **Генерація офлайн-скрипта (без доступу до БД, безпечно виконати вже зараз якщо дозволено):**
   `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/test-init.sql`
   (генерація тексту, жодного підключення; файл переглянути вручну перед застосуванням).
2. **Ініціалізація `pft_dbtest` під роллю `pft_test_init`** (Neon SQL Editor або psql з `OBSERVABILITY_TEST_DB_URL`-аналогом для init-ролі):
   застосувати `prisma/test-init.sql` (цей скрипт ідемпотентно-безпечний для порожньої БД: `CREATE TABLE`).
   Альтернатива (якщо diff-шлях неприйнятний): owner-затверджений одноразовий `prisma db push` з `DATABASE_URL` → URL `pft_dbtest` під `pft_test_init` — але шлях (1) безпечніший і оглядовий.
3. **Seed-дані НЕ потрібні:** усі 19 тестів створюють власні фікстури (`phase11045-*`, `p11045:` PREFIX, `pftconc-*`); залежностей від seed немає (провірено по трьох файлах).
4. **Фікстури не містять реальних PII/фінансових даних:** синьтетичні імена/валиди/wallet-маркери (`conc-test-wallet`), TEST-NET IP-адреси, `@test.local`/`@conc.test` домени. **PASS.**
5. Залежностей між міграціями немає (єдиний монолітний скрипт from-empty).

Послідовність: (роль-план F) → (скрипт 1) → (застосування 2) → owner встановлює `OBSERVABILITY_TEST_DB_URL` (+`PAYOUT_CONCURRENCY_TEST_DB_URL` або використання canonical-пари для всіх 19 тестів після оновлення payout-файла — зараз payout вимагає legacy-пару) → контрольована команда з I.

## H. Vercel Environment Isolation

| Variable | Development | Preview | Production | Рекомендація |
|---|---|---|---|---|
| `DATABASE_URL` | `.env.local` (dev-ціль) | **окрема Preview БД/Neon branch (окремий запис у preview scope)** | Production `neondb` (окремий запис у production scope) | розділити один запис Production+Preview (CRITICAL BLOCKER з 1.12, не змінено) |
| `DIRECT_URL` | — | — | — | не використовується; створювати лише за потреби (pooled vs direct) |
| `OBSERVABILITY_TEST_DB_URL` | `.env.local` → `pft_dbtest` @ `ep-icy-king-…` | НЕ потрібен (тести не в deployment) | НЕ потрібен | тільки локально/CI-машині; ніколи не вказувати на `neondb` |
| `PAYOUT_CONCURRENCY_TEST_DB(+URL)` | `.env.local` → та сама `pft_dbtest` | — | — | legacy-пара для 9 payout-тестів, той самий endpoint/БД |
| Shared/branch-specific | — | — | — | секрети ролей `pft_test_*` НЕ додавати у Vercel взагалі (тільки локально) |

Vercel-змінні в цьому етапі **не змінювалися** (жодних `env rm/add`, `env pull` із перезаписом). Фактичні endpoint/project/branch: підтверджені для тестового хоста (owner, Neon Console, branch `development`); для Production/Preview value-level — NOT VERIFIED (масковані значення, поза межами етапу).

## I. DB-Gated Tests Inventory (all 19)

### `scripts/gated/auth-login-db.test.ts` — 5 тестів (gate: canonical OBSERVABILITY_* пара)

| # | Тест | Що перевіряє | Таблиці (записи) | Cleanup | Prereq | Безпечно на pft_dbtest |
|---|---|---|---|---|---|---|
| 1 | admin login success | реальний route + `lib/admin/auth` (hashPassword, ADMIN_COOKIE) | User, RateLimitBucket, AuditLog | `after`: scoped deleteMany (bucket за created email/ip, audit за actorId, user за ids) | opt-in пара + схема | ТАК |
| 2 | wrong password → 401-подібна відмова | політика відмови | User (+bucket/audit за спроби) | той самий | — | ТАК |
| 3 | unknown email | відмова без розкриття існування | RateLimitBucket (лиміт) | той самий | — | ТАК |
| 4 | rate limit 429 після N спроб | durable limiter на реальній БД | RateLimitBucket | PREFIX-scoped | — | ТАК |
| 5 | cookie видається і валідується | сесійний механізм | User/AuditLog | той самий | `ADMIN_SESSION_SECRET` тестове значення (встановлює сам файл) | ТАК |

Фікстури: `phase11045-*@test.local`, сильний тестовий пароль. Порядок усередині файлу — послідовний, між файлами незалежні.

### `scripts/gated/rate-limit-store-db.test.ts` — 5 тестів (gate: canonical пара)

| # | Тест | Що перевіряє | Таблиці | Cleanup | Безпечно |
|---|---|---|---|---|---|
| 6 | create/increment bucket | `lib/security/rate-limit-store` durable-запис | RateLimitBucket | PREFIX `p11045:<ts>:` | ТАК |
| 7 | TTL/expiry поведінка | старий bucket не блокує | RateLimitBucket | PREFIX | ТАК |
| 8 | window reset | лічильник скидається після вікна | RateLimitBucket | PREFIX | ТАК |
| 9 | concurrent increments | атомарність оновлення | RateLimitBucket | PREFIX | ТАК |
| 10 | missing/нуллові ключі | fail-safe API | RateLimitBucket | PREFIX | ТАК |

### `scripts/payout-concurrency.test.ts` — 9 тестів (gate: legacy PAYOUT_* пара, `{legacy:true}`)

| # | Тест | Що перевіряє | Таблиці | Cleanup | Безпечно |
|---|---|---|---|---|---|
| 11 | Q2: payout lifecycle | request→approve→confirm фінансові інваріанти | User, TradingAccount, Payout, AccountLedgerEntry, AuditLog | per-scenario deleteMany + account + user | ТАК |
| 12 | Q9 Case A: approve race (20 ітерацій) | подвійний approve неможливий | ті самі + AccountBreachEvent | той самий | ТАК |
| 13 | Q9 Case B: confirm race | подвійний confirm → одна виплата | ті самі | той самий | ТАК |
| 14 | Q9 Case C: mixed race | approve-vs-confirm узгоджений фінал | ті самі | той самий | ТАК |
| 15 | approve-vs-reject race | XOR: MANUALLY_PAID або REJECTED | ті самі | той самий | ТАК |
| 16 | confirm-vs-reject race | одна фінансова мутація | ті самі | той самий | ТАК |
| 17 | reject-vs-archive race | термінальний стан узгоджений | ті самі + TradeHistory | той самий | ТАК |
| 18 | parallel double reject / double confirm | ідемпотентність | ті самі | той самий | ТАК |
| 19 | Q5: news-hold eligibility | active hold блокує; expired не блокує | ті самі | той самий | ТАК |

Фікстури: `pftconc-*` cuid, `@conc.test`, wallet `conc-test-wallet`, TEST-NET IP; `SET LOCAL statement_timeout=15000`/`lock_timeout=10000`; реальні бізнес-модулі (`breach-matrix`, `payout-execution`, `eligibility`, `archive`).

**Єдина контрольована команда (після всіх safety gates і owner-дозволу):**

```
# обидві пари вказують на ту саму pft_dbtest @ ep-icy-king-b4ozchkf (значення не друкувати в логи звіту)
node --experimental-test-module-mocks --import tsx --test scripts/gated/auth-login-db.test.ts scripts/gated/rate-limit-store-db.test.ts scripts/payout-concurrency.test.ts
```

Це ті самі три файли, що й `npm run test:db:gated` (використання npm-скрипта еквівалентне; прямий `node` дає exit 0 при 19 SKIP). Окремої послідовності між файлами не потрібно (кожен файл самодостатній, cleanup сам себе); усередині payout-файлу тестів race-сценарії несуть власні таймаути. Повторний запуск безпечний.

## J. Regression Results

| Перевірка | Результат |
|---|---|
| Повний прогін | **638 / 557 PASS / 0 FAIL / 81 SKIP**, exit 0 (двічі: до/після tsc-фіксу) |
| Бейзлайн 1.15 | 634 / 553 / 0 / 81 |
| Дельта | **+4 тести / +4 PASS** — пояснено: role-pinning тести в `observability-db-gate.test.ts` (default OFF, правильна роль, неправильна роль + disconnect, whitespace = OFF) |
| Гейт-набір сам | 35/35 PASS (31 + 4 нових) |
| `npm run test:db:gated` | 19/19 SKIPPED, 0 fail (безпечно без опт-іну; прямий node-запит exit 0) |
| TypeScript | exit 0 (проміжна помилка типу в constraint `assertClientIsTestDb` виправлена в межах етапу) |
| ESLint | 0 errors (touched-файли + повний набір у 1.15) |
| `npx prisma validate` | valid |
| `git diff --check` | exit 0 |
| Production build / CI | build не вимагався (кодові зміни — scripts-only); CI-конфігурації немає |

Зміни цього етапу: `scripts/observability-db-gate.ts` (role-pinning, default OFF), `scripts/observability-db-gate.test.ts` (+4 тести), `docs/PFT-phase-1.16-report.md`. HEAD/коміти не змінено.

## K. Blockers and Owner Actions

| # | Дія | Пріоритет | Де | Що саме |
|---|---|---|---|---|
| 1 | Валідні credentials для `pft_dbtest` | **CRITICAL (єдиний блокер тестів)** | Neon Console + локально | створити ролі за планом F → ініціалізувати схему за планом G → встановити `OBSERVABILITY_TEST_DB_URL` (+`PAYOUT_CONCURRENCY_TEST_DB_URL`, та сама БД) у `.env.local` (НЕ у Vercel); значення не друкувати |
| 2 | Розділити `DATABASE_URL` Production/Preview | CRITICAL (поза цим етапом, з 1.12) | Neon + Vercel | окремі записи за таблицею H |
| 3 | Гвард для `prisma/seed.ts` | HIGH | репозиторій | додати fail-closed перевірку ідентичності/`PFT_SEED=1` перед масовими deleteMany (окремий дозвіл — файл production-facing) |
| 4 | CI-відсутність | OPTIONAL | `.github/workflows` | якщо з'явиться CI — продублювати там гварди і `test:db:gated` |

## L. Exact Next-Step Commands (після owner-дозволу)

```powershell
# 1) (у Neon SQL Editor, під neondb_owner) — виконати SQL-план F
# 2) згенерувати ініціалізаційний скрипт (офлайн, без БД):
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/test-init.sql
#    переглянути файл; застосувати у Neon SQL Editor ПІД pft_test_init, контекст БД pft_dbtest
# 3) локальні env (у .env.local, значення НЕ друкувати):
#    OBSERVABILITY_TEST_DB=1
#    OBSERVABILITY_TEST_DB_URL=postgresql://pft_test_runtime:<pw>@ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech/pft_dbtest?sslmode=verify-full
#    PAYOUT_CONCURRENCY_TEST_DB=1
#    PAYOUT_CONCURRENCY_TEST_DB_URL=<той самий URL>
#    TEST_DB_EXPECTED_ROLE=pft_test_runtime
# 4) контрольований запуск:
npm run test:db:gated
# 5) повна регресія:
node --experimental-test-module-mocks --import tsx --test scripts/*.test.ts
```

Очікування: 19/19 PASS у gated-наборі; повна регресія 638+19=657 тестів (skips −19).

## M. Final Verdict

| Критерій K | Статус |
|---|---|
| 1. `pft_dbtest` — окрема база | **PARTIAL** — owner підтвердив створення в Neon Console; value-level identity ще не доведена (немає credentials) |
| 2. Фактичний endpoint/project/branch | **PARTIAL** — хост owner-підтверджений і зафіксований exact-allowlist-ом; branch `development` — зі слів owner-а, live-перевірка після видачі credentials |
| 3. Production не використовується harness-ом | **PASS** (доказ структурний: немає шляхів до `DATABASE_URL`, denylist, live `current_database()`) |
| 4. Небезпечні операції проаналізовані | **PASS** (E: 19 тестів чисті; знайдено незахищений `prisma/seed.ts` — задокументовано) |
| 5. Fail-closed план | **PASS** (наявний гейт + новий role-pinning, default OFF) |
| 6. План окремої ролі | **PASS** (SQL-план F, не застосовувався) |
| 7. Безпечний план ініціалізації схеми | **PASS** (offline diff-скрипт, `db push` відхилено як незатверджений) |
| 8. Інвентаризація 19 тестів | **PASS** (таблиці I, з таблицями/cleanup/prereq) |
| 9. Команда контрольованого запуску | **PASS** (I/L) |
| 10. Незадокументованих змін Production немає | **PASS** (жодних змін) |

**Статус: READY FOR OWNER AUTHORIZATION.** Жодного підключення до БД, жодного запису, жодного GRANT — тільки аудит, hardening (зворотно сумісний, протестований) і плани. Наступна дія — за власником: SQL-план F + ініціалізація G + локальні env → команда з L.
