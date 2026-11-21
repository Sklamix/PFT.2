# PFT — PHASE 1.17: Owner Execution Plan v3 — `pft_dbtest` Role Isolation & Schema Initialization

Дата: 2026-11-13
Контекст: Neon проєкт `curly-hill-43179499`, гілка `preview` (`br-dry-rain-b4p49oe4`), база `pft_dbtest` існує і порожня.
Цей документ — інструкція для власника. **Виконується вручну в Neon SQL Editor / psql.** Жоден крок не виконується агентом. Паролів та connection strings у документі немає.

Версія v3 виправляє 3 дефекти v2 (виявлені власником):

| # | Дефект v2 | Виправлення в v3 |
|---|---|---|
| 1 | `REVOKE ALL ON DATABASE neondb FROM roles` не скасовує права, отримані через **PUBLIC** (`=Tc/` = CONNECT+TEMPORARY) | семантика уточнена: REVOKE залишається як defense-in-depth; PUBLIC на `neondb` **не ревокається автоматично** — аналіз наслідків у `PFT-phase-1.17-security-review-v3.md`; строгий варіант — тільки як Опція B з явним impact-листом |
| 2 | Перевірка `pg_auth_members` фільтрувала `r.rolname` (granted role), а не `m.rolname` (member) | фільтр перенесено на `m.rolname IN ('pft_test_init','pft_test_runtime')` |
| 3 | `has_database_privilege('public', …)` — неіснуючий pseudo-role | замінено на пряму перевірку ACL через `pg_database.datacl` (включно з `NULL` = дефолтні PUBLIC-права) |

## 0. Фактичний стан (read-only MCP-аудит, 2026-11-13)

| Об'єкт | Факт |
|---|---|
| `neondb` datacl | `=Tc/neondb_owner` (PUBLIC: TEMPORARY+CONNECT) `| neondb_owner=CTc/…` `| neon_superuser=CTc/…` |
| `pft_dbtest` datacl | `NULL` ⇒ дефолт ⇒ PUBLIC має CONNECT+TEMPORARY |
| Схема `public` (обидві БД) | `pg_database_owner=UC/…` `| =U/…` — PUBLIC має USAGE, **не має CREATE** |
| PUBLIC table grants | **0** в `neondb`, **0** в `pft_dbtest` |
| `pg_default_acl` | 2 записи в `neondb`, 0 в `pft_dbtest` |
| `neon_service` | CREATEDB+CREATEROLE, член `neon_superuser`, **не має явного запису в datacl `neondb`** ⇒ підключається через PUBLIC CONNECT |
| Членства | `neon_service→neon_superuser`, `neondb_owner→neon_superuser` + 12 службових; жодних груп, у які могли б автоматично потрапити нові ролі |

**Висновок:** PUBLIC у `neondb` має лише CONNECT+TEMPORARY і **нуль** прав на таблиці — тому CONNECT тестових ролей до `neondb` (через PUBLIC) не дає їм доступу до даних. Це і є основою Опції A.

## 1. SQL-план (ФІНАЛЬНИЙ, v3 — Опція A, за замовчуванням)

Виконати в Neon SQL Editor у контексті бази `pft_dbtest` (під `neondb_owner`).

```sql
-- ===== КРОК 1: ролі (мінімальні атрибути) =====
CREATE ROLE pft_test_init  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<згенерувати власнику в менеджері паролів>';
CREATE ROLE pft_test_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<згенерувати власнику в менеджері паролів>';

-- ===== КРОК 2: права на pft_dbtest =====
-- Закрити PUBLIC на тестовій БД (безпечні зміни ТІЛЬКИ в pft_dbtest)
REVOKE CONNECT, TEMPORARY ON DATABASE pft_dbtest FROM PUBLIC;
GRANT CONNECT ON DATABASE pft_dbtest TO pft_test_init, pft_test_runtime;

-- Схема: PUBLIC поза грою; init отримує DDL-створення (без власності бази => без DROP DATABASE)
REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO pft_test_init;
GRANT USAGE ON SCHEMA public TO pft_test_runtime;

-- ===== КРОК 3: defense-in-depth проти neondb =====
-- Прибирає будь-які ЯВНІ записи цих ролей у datacl neondb (сейчас їх немає).
-- НЕ скасовує PUBLIC-права (=Tc/): безпечна альтернатива з'являється лише як Опція B.
REVOKE ALL ON DATABASE neondb FROM pft_test_init, pft_test_runtime;

-- ===== КРОК 4 (ПІСЛЯ ініціалізації схеми): DML-права =====
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init IN DATABASE pft_dbtest
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init IN DATABASE pft_dbtest
  GRANT USAGE, SELECT ON SEQUENCES TO pft_test_runtime; -- превентивно; sequences у схемі немає
```

Залишковий ризик Опції A (документований, див. security-review v3): тестові ролі **технічно зберігають** CONNECT+TEMPORARY на `neondb` через PUBLIC, але не мають там жодних прав на дані (0 PUBLIC table grants, схема public без CREATE). Жоден тест не звертається до `neondb`.

## 2. Default privileges: хто виконує `ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init`

`ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init` вимагає, щоб сесія виконувалась **AS `pft_test_init`**, або щоб виконавець був членом цієї ролі. `neondb_owner` **не** є членом `pft_test_init`, тому крок 4 у формі вище під `neondb_owner` видасть помилку. Два шляхи:

- **Шлях 1 (рекомендований):** підключитися під `pft_test_init` (psql з connection string цієї ролі до `pft_dbtest`) і виконати:
  ```sql
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO pft_test_runtime;
  ```
  (без `FOR ROLE` — сесія сама є тією роллю). Форма `FOR ROLE pft_test_init` теж коректна у цій сесії.
- **Шлях 2 (якщо Console не дозволяє сесію під init-роллю):** виконати весь init-SQL і GRANT-и під `neondb_owner`, тоді:
  ```sql
  ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN DATABASE pft_dbtest
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
  ```
  Таблиці створюються під `neondb_owner` → дефолтні привілеї від `neondb_owner` саме їх і покривають. Власність таблиць у `neondb_owner` — прийнятно, DML-роль власником не стає.

Зауваження: default privileges у Postgres **per-database**; застосовуються до об'єктів, створених відповідною роллю ПІСЛЯ виконання команди. `GRANT ... ON ALL TABLES IN SCHEMA public` у кроці 4 (після init) покриває всі 43 існуючі таблиці, default privileges — лише майбутні.

## 3. Порядок застосування (Опція A)

1. Крок 1 (ролі) → 2. Кроки 2–3 → 3. Перевірки розділу 4 → 4. Ініціалізація схеми (розділ 5) → 5. Крок 4 (Шлях 1 або 2) → 6. Перевірки розділів 6–7 → 7. Connection strings (розділ 8). Строга ізоляція від `neondb` — окреме рішення власника (Опція B, security-review v3).

## 4. Перевірки ізоляції (виправлені, v3)

**4.1. Явні ACL тестових ролей на обидві бази (заміна `has_database_privilege('public',…)`):**

```sql
-- Власна перевірка PUBLIC-ACL: datacl NULL = дефолт (PUBLIC CONNECT+TEMPORARY)
SELECT datname, datacl
FROM pg_database WHERE datname IN ('neondb','pft_dbtest');
-- ОЧІКУВАННЯ після кроків 2–3:
--   pft_dbtest: datacl МІСТИТЬ "=c/"-відсутність... => жодного "=Tc" запису;
--   neondb: datacl = "=Tc/neondb_owner | neondb_owner=CTc/… | neon_superuser=CTc/…" (без записів тестових ролей)
-- Інтерпретація: запис "=Tc/<grantor>" означає PUBLIC TEMPORARY+CONNECT від grantor.

-- Явні ACL-записи тестових ролей на neondb (мають бути порожні)
SELECT datname, datacl FROM pg_database
WHERE datname = 'neondb'
  AND datacl::text LIKE '%pft_test%';
-- очікування: 0 рядків
```

**4.2. Членства — виправлений фільтр (member = тестові ролі):**

```sql
SELECT r.rolname AS granted_role, m.rolname AS member
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE m.rolname IN ('pft_test_init','pft_test_runtime');
-- очікування: 0 рядків
```

**4.3. Атрибути та фактичні права ролей:**

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin
FROM pg_roles WHERE rolname IN ('pft_test_init','pft_test_runtime');
-- очікування: rolsuper/rolcreatedb/rolcreaterole = false; rolcanlogin = true; rolinherit = true

-- Фактичні ефективні права (які POSTGRES обчислює сам, PUBLIC включно):
SELECT has_database_privilege('pft_test_init','neondb','CONNECT'),    -- true (через PUBLIC — залишок Опції A)
       has_database_privilege('pft_test_init','neondb','TEMPORARY'),  -- true (через PUBLIC — залишок Опції A)
       has_database_privilege('pft_test_init','neondb','CREATE'),     -- false
       has_database_privilege('pft_test_runtime','neondb','CONNECT'), -- true (через PUBLIC — залишок Опції A)
       has_database_privilege('pft_test_runtime','neondb','CREATE');  -- false
-- УВАГА: дві "true" у neondb — це документований залишок Опції A (CONNECT+TEMPORARY через PUBLIC,
-- без прав на дані). Якщо власник обирає Опцію B — ці значення стануть false.

SELECT has_database_privilege('pft_test_runtime','pft_dbtest','CREATE'); -- false
SELECT has_schema_privilege('pft_test_runtime','public','CREATE');       -- false
SELECT has_schema_privilege('pft_test_init','public','CREATE');          -- true
SELECT has_database_privilege('pft_test_runtime','pft_dbtest','CONNECT'); -- true

-- Доступ до даних neondb (має бути порожньо):
SELECT count(*) FROM information_schema.role_table_grants
WHERE grantee = 'PUBLIC'; -- neondb: 0
```

**4.4. Практична перевірка (опціонально):** спроба `SELECT * FROM "User" LIMIT 1;` під `pft_test_runtime` у контексті `neondb` має дати `permission denied for table "User"` — це і є доказом, що CONNECT без table-grant не дає доступу до даних.

## 5. Ініціалізація схеми

- Джерело: `docs/pft_dbtest-init-preview.sql` (офлайн-генерація; НЕ виконувався).
- **Верифіковано (F):** файл містить лише `CREATE SCHEMA IF NOT EXISTS "public"` (пропуститься з notice), `CREATE TYPE` ×34, `CREATE TABLE` ×43, `CREATE INDEX/UNIQUE INDEX` ×97, `ALTER TABLE … ADD CONSTRAINT` ×39 (єдині ALTER — саме ADD CONSTRAINT; нуль ALTER DATABASE/ROLE, COMMENT, SECURITY DEFINER, EXTENSION, FUNCTION, TRIGGER). Жоден стейтмент не вимагає власності бази — `pft_test_init` виконує весь файл без `ALTER DATABASE pft_dbtest OWNER TO`.
- Власником усіх таблиць стане та роль, під якою виконано файл: перевага — `pft_test_init` (тоді default privileges Шляху 1 покривають майбутні об'єкти).

## 6. Перевірка кількості таблиць

```sql
SELECT count(*) FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE';
-- очікування: 43
```
Єдина очікувана розбіжність імен: модель `MarketCandle` → таблиця `GoldCandle` (`@@map`).

## 7. Connection strings

1. Neon Console → branch `preview` → Endpoint → Connection Details → Role `pft_test_runtime`, Database `pft_dbtest` → рядок **не копіювати у звіти/чати**.
2. Локально в `.env.local` (НЕ у Vercel):
```
OBSERVABILITY_TEST_DB=1
OBSERVABILITY_TEST_DB_URL=<string під pft_test_runtime>
PAYOUT_CONCURRENCY_TEST_DB=1
PAYOUT_CONCURRENCY_TEST_DB_URL=<той самий string>
TEST_DB_EXPECTED_ROLE=pft_test_runtime
```
3. Гейт сам перевірить: host allowlist, db name, `sslmode=verify-full`, живі `current_database()` + `current_user()`.

## 8. Умови запуску 19 тестів

Усі одночасно: кроки 1–4 застосовані; перевірки 4.1–4.3 збігаються з очікуваннями (включно з документуванням двох "true" через PUBLIC у neondb як залишку Опції A); схема ініціалізована (43 таблиці); env-пари записані; `npm run test:db:gated` → 19/19 PASS (0 SKIP); після тестів — лише маркеровані рядки.

## 9. Опція B (строгий варіант, ТІЛЬКИ за явним рішенням власника)

```sql
-- ПОПЕРЕДЖЕННЯ: впливає на ВСІХ, хто підключається до neondb через PUBLIC.
-- ПЕРЕД виконанням: надати явний CONNECT тих, кому треба (див. security-review v3):
GRANT CONNECT ON DATABASE neondb TO neon_service;  -- мінімум: інакше neon_service втратить доступ
-- Потім:
REVOKE CONNECT, TEMPORARY ON DATABASE neondb FROM PUBLIC;
-- Після цього перевірки 4.3 дадуть false для CONNECT/TEMPORARY тестових ролей на neondb.
```
Повний impact-лист і необхідні owner-рішення — у `docs/PFT-phase-1.17-security-review-v3.md`.
