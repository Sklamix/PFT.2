# PFT — PHASE 1.17: Test Database Role Isolation & Schema Initialization Preparation

Дата: 2026-11-13
Статус: **READY FOR OWNER EXECUTION**
Базис: branch `staging/ai-support-reliability`, HEAD `6561d8b` (не змінено), 128 записів у робочому дереві (усі збережено, нові — лише документація та згенерований SQL).
База даних: **жодних змін** — усі звернення до Neon лише через read-only MCP (`run_sql` SELECT-и, `get_database_tables`, `describe_table_schema`).

---

## A. Executive Summary

Підготовлено повний ручний план ізоляції ролей та ініціалізації схеми для `pft_dbtest` (гілка `preview` проєкту `curly-hill-43179499`). Рольовий план PHASE 1.16 провірено рев'ю-ом і **знайдено 4 реальні пробіли** (PUBLIC-права на БД/схему, надлишкова власність бази з можливістю DROP, неперевірений ризик успадкованих членств) — у `docs/PFT-phase-1.17-owner-execution-plan.md` опубліковано виправлений **SQL v2**. Схему згенеровано офлайн у `docs/pft_dbtest-init-preview.sql` (43 таблиці / 34 enum / 97 індексів / 39 FK; нуль destructive-стейтментів; невідповідностей Prisma schema немає). Сумісність усіх 19 DB-gated тестів із DML-only роллю доведена перехресним аналізом (жодного DDL, жодного доступу до `neondb`, sequences не потрібні). Усі локальні перевірки зелені.

## B. Блок A — рев'ю рольового плану PHASE 1.16

Джерело: `docs/PFT-phase-1.16-report.md`, розділ F (v1-план: `CREATE ROLE` × 2, `REVOKE ALL ON DATABASE neondb`, `GRANT CONNECT/USAGE/ALL ON SCHEMA`, `ALTER DATABASE pft_dbtest OWNER TO pft_test_init`, `ALTER DEFAULT PRIVILEGES`).

| # | Питання з брифінгу | Вердикт v1 | Деталі |
|---|---|---|---|
| 1 | Ролі обмежені `pft_dbtest`? | **ЧАСТКОВО** | CONNECT/TEMP на `pft_dbtest` у v1 лишалися у PUBLIC → будь-яка login-роль могла входити. Виправлено: `REVOKE CONNECT, TEMPORARY ... FROM PUBLIC` |
| 2 | Не можуть підключитися до `neondb`? | **ТАК, з зауваженням** | `REVOKE ALL ON DATABASE neondb FROM role` коректно прибирає CONNECT/TEMP/CREATE для самих ролей; але v1 не доводила відсутність успадкованих членств → у v2 додано перевірку `pg_auth_members` (очікування: 0 рядків) |
| 3 | `pft_test_init` — лише потрібне для ініціалізації? | **НІ** | v1 давала `GRANT ALL ON SCHEMA` + **власність бази** (→ можливість `DROP DATABASE`). v2: лише `USAGE, CREATE ON SCHEMA public`; власність бази НЕ передається |
| 4 | `pft_test_runtime` — лише DML? | **ТАК** | `CONNECT` + `USAGE` на схему + `SELECT/INSERT/UPDATE/DELETE` на таблиці; без `CREATE` |
| 5 | Зайві привілеї? | **Исправлено в v2** | `NOSUPERUSER NOCREATEDB NOCREATEROLE` тепер явні |
| 6 | Schema/sequences/existing objects/default privileges? | **ЧАСТКОВО** | v1: GRANT ON ALL TABLES до ініціалізації (порожньо на той момент) — default privileges були, але тільки для TABLES. v2: GRANT існуючих таблиць ПІСЛЯ init + default privileges для TABLES **і SEQUENCES** (превентивно; в схемі sequences немає — усі PK текстові cuid) |
| 7 | Небезпечні шляхи через PUBLIC/успадкування? | **Виправлено в v2** | PUBLIC: REVOKE `CONNECT, TEMPORARY` на БД + REVOKE `USAGE, CREATE` на схему public у `pft_dbtest`; членства: перевірка 4.2 у плані |

**Ключовий підсумок:** `REVOKE ALL` сам по собі **не** прибирає PUBLIC-права (він діє лише на роль) — тому v2 ревокує права саме з PUBLIC. Успадковані права у v1 неможливі за замовчуванням (нові ролі не мають членств), але тепер це доводиться перевіркою, а не припущенням.

## C. Блок B — offline schema generation

**Виконано (offline, без доступу до БД):**
```
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
→ docs/pft_dbtest-init-preview.sql  (~101 KB, 213 стейтментів)
```

Рев'ю згенерованого SQL:

| Перевірка | Результат | Статус |
|---|---|---|
| Destructive statements (DROP/TRUNCATE/DELETE/UPDATE/INSERT) | **нуль** (єдині збіги grep-а — імена колонок `revokedAt`/`revokeReason`) | **PASS** |
| GRANT/REVOKE/ROLE statements | **нуль** — скрипт не містить привілейованих стейтментів | **PASS** |
| Порядок створення | enums → tables (до рядка 972) → FK-ALTER (з 1276) → індекси: FK-и не спереду, циклів у lint-і Prisma немає | **PASS** |
| Індекси/FK/constraints | 62 `CREATE INDEX` + 35 `CREATE UNIQUE INDEX`, 39 FOREIGN KEY, PK і NOT NULL у кожній таблиці | **PASS** |
| Відповідність Prisma schema | 43 `CREATE TABLE` ↔ 43 `model` (ідентичні списки; єдина "розбіжність" `MarketCandle`↔`GoldCandle` — це `@@map("GoldCandle")` у схемі, таблиця `GoldCandle` підтверджена й у `neondb` гілки preview); 34 `CREATE TYPE` ↔ 34 `enum` | **PASS** |
| Небезпечні привілеї / OWNER / SECURITY DEFINER | **нуль** | **PASS** |
| Sequences | autoincrement у схемі відсутній (0 збігів `@default(autoincrement)`, SERIAL, IDENTITY) — sequences не генеруються | **PASS** |
| `CREATE SCHEMA IF NOT EXISTS "public"` | у наявній БД пропускається з notice — безпечно навіть без прав власника схеми | **PASS** |

**Файл НЕ виконувався** — призначений лише для ручного застосування власником.

## D. Блок C — сумісність 19 тестів із `pft_test_runtime` (DML-only)

Метод: grep-аналіз фактичних Prisma-операцій у трьох файлах + інвентаризація 1.16.

| Файл (тестів) | Таблиці | Операції (факт, grep) | Cleanup | Сумісність |
|---|---|---|---|---|
| `gated/auth-login-db.test.ts` (5) | User, RateLimitBucket, AuditLog | `.create`, `findMany/findUnique` (неявно через Prisma-запити), `deleteMany` ×3 (scoped) | scoped deleteMany за email/ids | **ТАК** |
| `gated/rate-limit-store-db.test.ts` (5) | RateLimitBucket | `.create`, `.update`, `deleteMany` (PREFIX) | PREFIX deleteMany | **ТАК** |
| `payout-concurrency.test.ts` (9) | User, TradingAccount, Payout, AccountLedgerEntry, AuditLog, AccountBreachEvent, TradeHistory | `.create` ×13, `.update` ×4, `updateMany` ×1, `deleteMany` ×4, `findMany` ×13, `$transaction` ×1 | per-scenario deleteMany + account + user delete | **ТАК** |

Raw-SQL у тестах (перевірено по рядках):
- `$queryRaw` ×2: обидва — `SELECT "id" ... FOR UPDATE` (row lock, read-only).
- `$executeRaw` ×2: обидва — `SET LOCAL statement_timeout/lock_timeout` (сесійні параметри, привілеїв не потребують).
- **DDL під runtime-роллю: не потрібно. Доступу до `neondb`: немає. Production credentials: не використовуються (гейт резолвить URL з окремої пари env). Глобального видалення: немає (усі deleteMany — scoped). `prisma/seed.ts`: не використовується жодним тестом.**

Висновок: `pft_test_runtime` з правами `SELECT/INSERT/UPDATE/DELETE ON ALL TABLES` + `CONNECT` + `USAGE ON SCHEMA` повністю покриває всі 19 тестів. `GRANT ... ON ALL TABLES` у кроці 4 (після init) покриває всі 43 таблиці.

## E. Блок D — Owner Execution Plan

Створено `docs/PFT-phase-1.17-owner-execution-plan.md`: фінальний SQL v2 (роли → права pft_dbtest → заборона neondb → DML-гранти після init), порядок застосування, identity-перевірки (`current_database()`/`current_user()`), 3 блоки isolation-перевірок (`has_database_privilege`, `pg_auth_members`, `has_schema_privilege`), порядок ініціалізації, перевірка 43 таблиць, форма connection strings (без паролів), умови запуску 19 тестів. Паролів і connection strings у документі немає.

## F. Блок E — локальні перевірки

| Перевірка | Результат |
|---|---|
| TypeScript `npx tsc --noEmit` | exit 0 |
| ESLint (повний) | 0 errors, 63 warnings (pre-existing), exit 0 |
| `npx prisma validate` | valid |
| `git diff --check` | чисто |
| DB-gated тести | **НЕ запускалися** (заборонено етапом) |
| Neon БД | жодних змін (лише read-only MCP SELECT-и) |
| Vercel env / MCP-конфіг / `DATABASE_URL` | не змінювалися |

## G. Створено локально

| Файл | Що це |
|---|---|
| `docs/pft_dbtest-init-preview.sql` | Згенерований offline-скрипт схеми (43 таблиці/34 enum/97 індексів/39 FK), рев'юнутий, НЕ виконаний |
| `docs/PFT-phase-1.17-owner-execution-plan.md` | Покроковий план для власника з фінальним SQL v2 та всіма перевірками |
| `docs/PFT-phase-1.17-report.md` | Цей звіт |

## H. Що залишається невідомим

1. Фактична поведінка Console "run as role" (якщо недоступна — init під `neondb_owner` з явним ALTER OWNER-варіантом, описаним у плані).
2. Повне дерево гілок проєкту (read-only MCP не показує) — Production-ізоляція доводиться projectId-pinning-ом структурно.
3. Відсутність успадкованих ролей у `neondb_owner` на момент виконання — перевіряється owner-ом у розділі 4.2 плану.

## I. Owner Actions (єдині)

1. Виконати SQL v2 кроки 1–3 у Neon Console (`pft_dbtest`).
2. Прогнати isolation-перевірки розділу 4 плану.
3. Застосувати `docs/pft_dbtest-init-preview.sql` у контексті `pft_dbtest`.
4. Виконати крок 4 (DML-гранти), перевірити 43 таблиці (розділ 6).
5. Створити connection string для `pft_test_runtime` і записати локальні env-пари (розділ 7; значення не публікувати).
6. Після цього — контрольований запуск `npm run test:db:gated` (очікування 19/19 PASS).

## J. Final Verdict

**READY FOR OWNER EXECUTION.** Роль-план виправлено і посилено (v2), офлайн-скрипт схеми згенеровано і рев'юнуто, сумісність тестів доведена, локальні перевірки зелені, БД/конфіги недоторкані. Ручне застосування SQL власником — безпечне наступне рішення; жоден крок не потребує агентського доступу на запис.
