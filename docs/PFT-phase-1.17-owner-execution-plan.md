# PFT — PHASE 1.17: Owner Execution Plan — `pft_dbtest` Role Isolation & Schema Initialization

Дата: 2026-11-13
Контекст: Neon проєкт `curly-hill-43179499`, гілка `preview` (`br-dry-rain-b4p49oe4`), база `pft_dbtest` існує і порожня (підтверджено read-only MCP-аудитом).
Цей документ — інструкція для власника. **Виконується вручну в Neon SQL Editor** (з'єднання під `neondb_owner` у контексті бази `pft_dbtest`). Жоден крок не виконується автоматично агентом. Паролі та connection strings у документі відсутні — лише форми.

Оновлення проти SQL-плану PHASE 1.16 (розділ F): рев'ю виявило 4 пробіли — виправлені тут (v2), див. розділ 0.

---

## 0. Що виправлено проти плану 1.16 (v1 → v2)

| # | Пробіл у v1 | Ризик | Виправлення в v2 |
|---|---|---|---|
| 1 | `pft_dbtest` мала дефолтні PUBLIC-права (`CONNECT`, `TEMPORARY` — Postgres надає їх PUBLIC на кожній БД) | будь-яка login-роль акаунта/організації могла підключитися до тестової БД | `REVOKE CONNECT, TEMPORARY ON DATABASE pft_dbtest FROM PUBLIC` |
| 2 | `GRANT ALL ON SCHEMA public` + неявний `USAGE` для PUBLIC | PUBLIC міг користуватися схемою; `GRANT ALL` ширший за потреби | explicit `USAGE, CREATE` для init-ролі; `REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC` |
| 3 | `ALTER DATABASE pft_dbtest OWNER TO pft_test_init` | власник БД може її **DROP** — надлишкова привілея | власність НЕ передається; init-роль отримує лише `CREATE ON SCHEMA public` і володіє створеними об'єктами. `DROP DATABASE` для неї неможливий |
| 4 | `REVOKE ALL ON DATABASE neondb` не підтверджує відсутність успадкованих прав | успадковані членства могли б дати права повз REVOKE | явне `NOSUPERUSER NOCREATEDB NOCREATEROLE`, перевірочний запит `pg_auth_members` (розділ 4) |

Додатково зафіксовано: у схемі **немає autoincrement/serial** (усі PK — текстові cuid) — sequences-права зараз не потрібні; `ALTER DEFAULT PRIVILEGES ... ON SEQUENCES` додано превентивно.

## 1. SQL-план створення ролей (ФІНАЛЬНИЙ, v2)

Виконати в Neon SQL Editor, обравши базу `pft_dbtest` (або замінивши `pft_dbtest` на повну кваліфікацію — з'єднання під `neondb_owner`).

```sql
-- ===== КРОК 1: ролі (мінімальні атрибути) =====
CREATE ROLE pft_test_init  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<згенерувати власнику в менеджері паролів>';
CREATE ROLE pft_test_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<згенерувати власнику в менеджері паролів>';

-- ===== КРОК 2: права на pft_dbtest =====
-- Жодна PUBLIC-мова: тільки обидві тестові ролі + поточний owner можуть входити
REVOKE CONNECT, TEMPORARY ON DATABASE pft_dbtest FROM PUBLIC;
GRANT CONNECT ON DATABASE pft_dbtest TO pft_test_init, pft_test_runtime;

-- Схема: PUBLIC поза грою, init отримує DDL-створення (але НЕ власність бази => без DROP DATABASE)
REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO pft_test_init;
GRANT USAGE ON SCHEMA public TO pft_test_runtime;

-- ===== КРОК 3: повна заборона neondb =====
REVOKE ALL ON DATABASE neondb FROM pft_test_init, pft_test_runtime;
-- (дефолтні членства відсутні; це доводить перевірка 4.3 нижче)

-- ===== КРОК 4 (виконати ПІСЛЯ ініціалізації схеми, розділ 5): DML-права =====
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init IN DATABASE pft_dbtest
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init IN DATABASE pft_dbtest
  GRANT USAGE, SELECT ON SEQUENCES TO pft_test_runtime; -- превентивно; зараз sequences немає
```

Примітки:
- `DROP DATABASE pft_dbtest` недоступний жодній з тестових ролей (не власники) — reset бази можливий лише власнику через Console, що і є бажаним ручним шляхом.
- `GRANT ... ON ALL TABLES` у кроці 4 виконується після ініціалізації схеми, тому покриває всі 43 таблиці одразу; default privileges покривають майбутні.

## 2. Порядок застосування

1. Крок 1 (ролі) → 2. Кроки 2–3 (права pft_dbtest + заборона neondb) → 3. Перевірки розділу 4 → 4. Ініціалізація схеми (розділ 5, файл `docs/pft_dbtest-init-preview.sql`, під `pft_test_init` або під `neondb_owner` з подальшим `ALTER ... OWNER` — але простіше виконати файл саме під `pft_test_init`, тоді таблиці одразу належать init-ролі й default-privileges спрацюють) → 5. Крок 4 (DML-гранти) → 6. Перевірки розділу 6–7 → 7. Connection strings (розділ 8).

**Важливо:** файл `docs/pft_dbtest-init-preview.sql` містить `CREATE SCHEMA IF NOT EXISTS "public";` — у наявній БД цей стейтмент пропускається (notice), помилки не буде навіть без прав власника схеми.

## 3. Перевірка identity (після кроків 1–3)

У Neon SQL Editor змінити контекст бази на `pft_dbtest` і виконати:

```sql
SELECT current_database(), current_user, current_schema();
-- очікування: pft_dbtest | neondb_owner | public (доки виконання під owner-ом)
```

Потім тимчасово перевірити самі ролі (login під ними через psql або Console "Connect as role", якщо доступно):

```sql
-- під pft_test_runtime:
SELECT current_database(), current_user; -- очікування: pft_dbtest | pft_test_runtime
```

## 4. Перевірки ізоляції та відсутності зайвих привілеїв

**4.1. Runtime-роль не може підключитися до `neondb`:**
```sql
-- з'єднання під pft_test_runtime до neondb має завершитися:
-- FATAL: permission denied for database "neondb"
SELECT has_database_privilege('pft_test_runtime', 'neondb', 'CONNECT'); -- очікування: false
SELECT has_database_privilege('pft_test_runtime', 'neondb', 'TEMPORARY'); -- очікування: false
SELECT has_database_privilege('pft_test_init',   'neondb', 'CONNECT'); -- очікування: false
```

**4.2. Ролі без привілейованих атрибутів і без успадкування:**
```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
FROM pg_roles WHERE rolname IN ('pft_test_init','pft_test_runtime');
-- очікування: усі три прапорці = false

SELECT r.rolname AS role, m.rolname AS member_of
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE r.rolname IN ('pft_test_init','pft_test_runtime');
-- очікування: 0 рядків (жодних успадкованих ролей)
```

**4.3. Ролі мають мінімум на pft_dbtest:**
```sql
SELECT has_database_privilege('pft_test_runtime','pft_dbtest','CREATE');   -- очікування: false
SELECT has_schema_privilege('pft_test_runtime','public','CREATE');        -- очікування: false
SELECT has_schema_privilege('pft_test_init','public','CREATE');           -- очікування: true
SELECT has_database_privilege('public','pft_dbtest','CONNECT');           -- очікування: false (PUBLIC позбавлено)
```

## 5. Ініціалізація схеми `pft_dbtest`

- Джерело: `docs/pft_dbtest-init-preview.sql` (згенеровано офлайн: `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`; НЕ виконувався агентом).
- Застосувати увесь файл у Neon SQL Editor у контексті бази `pft_dbtest`, **під роллю `pft_test_init`** (якщо Console дозволяє "run as role"; інакше — під `neondb_owner`, але тоді перед кроком 4 додати: `ALTER TABLE ... OWNER TO pft_test_init;` для кожної з 43 таблиць — або спростити: виконати GRANT-и кроку 4 і залишити власником owner-а; головне — не залишати DML-роль власником).
- Скрипт рев'юнутий: 43 CREATE TABLE, 34 CREATE TYPE (enum), 97 CREATE INDEX (62 + 35 unique), 39 FOREIGN KEY; **нуль** DROP/TRUNCATE/GRANT/REVOKE/DELETE/UPDATE/INSERT; FK додаються після всіх таблиць (порядок коректний).

## 6. Перевірка кількості таблиць і відповідності Prisma schema

```sql
SELECT count(*) FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE';
-- очікування: 43

SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name;
-- звірити зі списком 43 моделей prisma/schema.prisma; єдина очікувана
-- розбіжність імен: модель MarketCandle => таблиця GoldCandle (@@map у схемі,
-- таблиця GoldCandle знайдена й у neondb гілки preview — консистентно)
```

Додатково: `SELECT count(*) FROM pg_type WHERE typname IN (перелік 34 enum)` або просто переконатися, що найбільший INSERT тесту пройде (перший запуск тестів і є перевіркою).

## 7. Connection strings для тестових ролей

1. Neon Console → project `curly-hill-43179499` → branch `preview` → Endpoint (pooled, той самий host, що в `DATABASE_URL` гілки) → Connection Details → Role: вибрати `pft_test_runtime`, Database: `pft_dbtest` → згенерований рядок **не копіювати у звіти/чати**.
2. Записати локально в `.env.local` (НЕ у Vercel):
   ```
   OBSERVABILITY_TEST_DB=1
   OBSERVABILITY_TEST_DB_URL=<string під pft_test_runtime>
   PAYOUT_CONCURRENCY_TEST_DB=1
   PAYOUT_CONCURRENCY_TEST_DB_URL=<той самий string>
   TEST_DB_EXPECTED_ROLE=pft_test_runtime
   ```
3. Гейт тестів сам перевірить: exact host allowlist, db name в URL, `sslmode=verify-full`, живі `current_database()` + `current_user()` (новий hardening 1.16).

## 8. Умови запуску 19 DB-gated тестів

Всі наступні умови мають бути істинними одночасно:
1. Ролі створені (розділ 1), ізоляційні перевірки розділу 4 — усі очікувані значення.
2. Схема ініціалізована (43 таблиці, перевірка розділу 6).
3. DML-гранти застосовані (крок 4).
4. Локальні env-пари записані (розділ 7.2); значення не публікуються.
5. Гейт зелений на sanity: `npm run test:db:gated` → 19/19 PASS (0 SKIP).
6. Після тестів: таблиці містять лише тестові рядки з маркерами (`phase11045-*`, `p11045:*`, `pftconc-*`); при потребі — ручна перевірка counts у Console.

Команда запуску: `npm run test:db:gated` (еквівалент прямого node-запуску трьох файлів).
