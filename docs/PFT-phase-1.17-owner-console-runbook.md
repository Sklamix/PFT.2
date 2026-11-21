# PFT — PHASE 1.17: Owner Console Runbook — Option A execution in Neon Console

Дата: 2026-11-13
Статус: **READY FOR OWNER REVIEW** (не READY FOR EXECUTION — див. §10 «Залишкові невизначеності»)
Джерела: `docs/PFT-phase-1.17-owner-execution-plan-v3.md`, `docs/PFT-phase-1.17-security-review-v3.md`, `docs/pft_dbtest-init-preview.sql`

Правила виконання (обов'язково):
- Neon MCP залишається `readonly=true`; SQL виконується ТІЛЬКИ вручну в Neon Console / psql.
- Не змінювати `neondb` ACL для PUBLIC, не переходити до Опції B.
- Не запускати DB-gated тести, не використовувати `prisma/seed.ts`.
- Паролі та connection strings НЕ копіювати у звіти, чати або логи агента.

Середовище: проєкт `curly-hill-43179499`, гілка `preview` (`br-dry-rain-b4p49oe4`). Головна роль: `neondb_owner` (контекст Neon Console). Вісь контекстів:

| Рівень | Що тут |
|---|---|
| Cluster-level (pg_catalog обох БД видимі з будь-якої БД) | `CREATE ROLE`, перевірки `pg_roles`, `pg_auth_members`, `pg_database` |
| БД `pft_dbtest` | REVOKE/GRANT на базу і схему, init-SQL, DML grants, default privileges |

Системні каталоги (`pg_roles`, `pg_auth_members`, `pg_database`) глобальні — їх можна читати з будь-якої бази. REVOKE/GRANT на базу `X` і `ALTER DEFAULT PRIVILEGES IN DATABASE` виконуються з'єднанням, підключеним до відповідної бази (для `ALTER DEFAULT PRIVILEGES ... IN DATABASE pft_dbtest` достатньо бути підключеним до `neondb`, бо база вказана явно; для форм без `IN DATABASE` — треба бути в `pft_dbtest`).

---

## Блок 0. Pre-check: повноваження `neondb_owner` (STOP-гейт)

**Де:** Neon SQL Editor, БД `pft_dbtest`. **Під роллю:** `neondb_owner`.

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit
FROM pg_roles WHERE rolname = 'neondb_owner';

-- Окремі sanity-перевірки для Блоку 2 (НЕ стосуються можливості CREATE ROLE):
SELECT has_database_privilege(current_user, 'pft_dbtest', 'CREATE'); -- у власника власної БД: true
SELECT has_schema_privilege(current_user, 'public', 'CREATE');       -- true
```

**Очікування (критерій CREATE ROLE):** `rolsuper = true` АБО `rolcreaterole = true` — тобто `NOT (rolsuper OR rolcreaterole)` = false. Важливо: **атрибути ролі (CREATEROLE/CREATEDB) не успадковуються через членство в іншій ролі** — ні до PG15 (атрибут діє лише на саму роль), ні в PG16+ (per-grant INHERIT стосується лише об'єктних привілеїв, не атрибутів). Отже членство `neondb_owner → neon_superuser` само по собі CREATEROLE не дає; прапорець `rolcreaterole` у `pg_roles` — коректний критерій для не-superuser. Два sanity-SELECT-и вище — лише підготовка до Блоку 2 і на рішення про CREATE ROLE не впливають.

**STOP якщо:** `NOT (rolsuper OR rolcreaterole)` — обидва прапорці `false` (незалежно від значень `has_database_privilege`). Це означає, що Блок 1 неможливий під `neondb_owner` → **BLOCKER**, зв'язатися з агентом перед будь-якими діями.

**Примітка:** ця перевірка не виконувалась агентом у цій фазі (заборонено виконувати SQL через MCP) — тому вона перша і обов'язкова.

---

## Блок 1. Створення ролей

**Де:** Neon SQL Editor, БД `pft_dbtest`. **Під роллю:** `neondb_owner`.

```sql
CREATE ROLE pft_test_init  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<згенерувати у менеджері паролів>';
CREATE ROLE pft_test_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  PASSWORD '<згенерувати у менеджері паролів>';
```

**Паролі (пункт 11):** генерувати в менеджері паролів, вставляти одразу в поле SQL Editor, виконувати, потім очищати поле/історію редактора; НЕ вставляти в чат, звіти, файли репозиторію або логи. Якщо Console запропонує власний генератор — використати його. Історію SQL Editor у Console за потреби перевірити й очистити.

**Очікування:** `CREATE ROLE` ×2 без помилок.

**STOP якщо:** `permission denied` / `must be superuser` / `Insufficient privileges` → BLOCKER (повернутись до Блоку 0, стоп і ескалація).

Контроль після блоку:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit
FROM pg_roles WHERE rolname LIKE 'pft_test_%';
-- очікування: 2 рядки; rolsuper/rolcreatedb/rolcreaterole = false; rolcanlogin = true; rolinherit = true
```

---

## Блок 2. Права на `pft_dbtest` (база + схема public)

**Де:** Neon SQL Editor, контекст БД **`pft_dbtest`** (важливо: не `neondb`). **Під роллю:** `neondb_owner`.

```sql
REVOKE CONNECT, TEMPORARY ON DATABASE pft_dbtest FROM PUBLIC;
GRANT  CONNECT ON DATABASE pft_dbtest TO pft_test_init, pft_test_runtime;

REVOKE USAGE, CREATE ON SCHEMA public FROM PUBLIC;
GRANT  USAGE, CREATE ON SCHEMA public TO pft_test_init;
GRANT  USAGE ON SCHEMA public TO pft_test_runtime;
```

**Очікування:** усі 5 стейтментів OK. `pft_dbtest` datacl втрачає дефолтний PUBLIC-запис (був `NULL` ⇒ дефолт; після REVOKE з'являється явна ACL без PUBLIC-прав).

**STOP якщо:** жодна помилка не очікується; будь-яка → стоп і ескалація (не імпровізувати).

---

## Блок 3. Defense-in-depth на `neondb` + перевірка ізоляції від `neondb`

**Де:** Neon SQL Editor. `REVOKE` можна виконати з будь-якої БД (роль-level команда), але контекст `pft_dbtest` зберігаємо для однорідності. **Під роллю:** `neondb_owner`.

```sql
-- 3.1 defense-in-depth: прибрати будь-які ЯВНІ ACL-записи тестових ролей на neondb
REVOKE ALL ON DATABASE neondb FROM pft_test_init, pft_test_runtime;
```

**Ця команда НЕ відкриває жодних прав на `neondb` і не чіпає PUBLIC** (перевірено у security-review v3 §A.1, §F). Потім перевірки:

```sql
-- 3.2 ACL-записи тестових ролей на neondb (мають бути порожні)
SELECT datname, datacl FROM pg_database
WHERE datname = 'neondb' AND datacl::text LIKE '%pft_test%';
-- очікування: 0 рядків

-- 3.3 datacl neondb: формат =Tc/<grantor> означає PUBLIC TEMPORARY+CONNECT.
--     Очікується НЕЗМІНЕНИМ (Опція A): "=Tc/neondb_owner | neondb_owner=CTc/… | neon_superuser=CTc/…"
SELECT datname, array_to_string(datacl, ' | ') FROM pg_database WHERE datname='neondb';
-- STOP якщо: запис "=Tc/…" ЗНИК — це означає, що хтось ревокнув PUBLIC на neondb (Опція B виконана
-- помилково). Тоді негайно зупинитись і ескалувати: це впливає на neon_service.

-- 3.4 ефективні права тестових ролей (облік PUBLIC виконує сам Postgres)
SELECT has_database_privilege('pft_test_init','neondb','CONNECT'),    -- true  (PUBLIC, залишок Опції A)
       has_database_privilege('pft_test_init','neondb','TEMPORARY'),  -- true  (PUBLIC, залишок Опції A)
       has_database_privilege('pft_test_init','neondb','CREATE'),     -- false
       has_database_privilege('pft_test_runtime','neondb','CONNECT'), -- true  (PUBLIC, залишок Опції A)
       has_database_privilege('pft_test_runtime','neondb','CREATE');  -- false
-- Два "true" — документований залишок Опції A; доступу до даних немає (0 PUBLIC table grants).

-- 3.5 PUBLIC-гранти на таблиці — information_schema.PER-DATABASE, тому виконується ДВАЧІ,
--     кожен запит у СВОЄМУ SQL Editor tab:
--
-- 3.5a У контексті БД **neondb** (окремий tab / окреме підключення саме до neondb):
SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC';
-- очікування: 0 — КЛЮЧОВИЙ доказ Опції A: PUBLIC не має грантів на таблиці neondb
--
-- 3.5b У контексті БД **pft_dbtest** (основний tab цього runbook):
SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC';
-- очікування: 0
```

---

## Блок 4. Перевірка членства в ролях (виправлений фільтр v3)

**Де:** будь-яка БД (каталог глобальний). **Під роллю:** `neondb_owner`.

```sql
SELECT r.rolname AS granted_role, m.rolname AS member
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE m.rolname IN ('pft_test_init','pft_test_runtime');
-- очікування: 0 рядків (жодних успадкованих ролей)
```

**STOP якщо:** ≥1 рядок — тестова роль успадковує чужі привілеї → BLOCKER, ескалувати.

---

## Блок 5. Ініціалізація схеми `pft_dbtest`

**Де:** Neon SQL Editor, контекст БД **`pft_dbtest`**.
**Під роллю:** `pft_test_init` (Шлях 1, рекомендовано) — через psql з connection string цієї ролі, або якщо Console дозволяє «run as role». Якщо ні — під `neondb_owner` (Шлях 2, допустимо; власником таблиць стане `neondb_owner`, DML-роль власником не стає).

**Файл:** `docs/pft_dbtest-init-preview.sql` (~101 KB, 213 стейтментів) — вставити цілком.

Верифікація файлу (виконана агентом офлайн): 43 `CREATE TABLE`, 34 `CREATE TYPE`, 97 `CREATE INDEX/UNIQUE INDEX`, 39× `ALTER TABLE … ADD CONSTRAINT` (єдині ALTER); нуль DROP/TRUNCATE/GRANT/REVOKE/DML/SECURITY DEFINER/EXTENSION/FUNCTION/TRIGGER/ALTER DATABASE/ALTER ROLE. `CREATE SCHEMA IF NOT EXISTS "public"` пропуститься з notice. Жоден стейтмент не потребує власності бази ⇒ **`pft_test_init` виконує все без `ALTER DATABASE pft_dbtest OWNER TO`**.

**Очікування:** 1 notice (`schema "public" already exists, skipping`) — і все; решта `CREATE …` OK.

**STOP якщо:**
- `permission denied for schema public` → значить Блок 2 не виконано в контексті `pft_dbtest` — перевірити і повторити Блок 2;
- будь-яка `already exists` для таблиць/типів (крім notice схеми) → база не була порожня — СТОП, ескалувати, не видаляти нічого самостійно;
- часткове застосування через розрив з'єднання → СТОП і ескалувати (не докатувати всліпу; потрібно рішення — файл ідемпотентний лише частково).

Контроль після блоку:

```sql
SELECT count(*) FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE';  -- очікування: 43
SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname='public' AND t.typtype='e';               -- очікування: 34
SELECT count(*) FROM pg_indexes WHERE schemaname='public';
-- очікування: 140 = 97 явних індексів (62 CREATE INDEX + 35 CREATE UNIQUE INDEX з init-SQL)
--                                + 43 PK-індекси, створені PRIMARY KEY-обмеженнями (_pkey),
--                                  які pg_indexes показує поряд з явними
-- FK: 39
SELECT count(*) FROM information_schema.table_constraints
WHERE table_schema='public' AND constraint_type='FOREIGN KEY';
-- Власник таблиць (Шлях 1 → pft_test_init; Шлях 2 → neondb_owner) — запам'ятати результат:
SELECT tableowner, count(*) FROM pg_tables
WHERE schemaname='public' GROUP BY tableowner;
```

---

## Блок 6. DML grants + default privileges

**Де:** контекст БД `pft_dbtest`.

### Шлях 1 (рекомендований) — сесія під `pft_test_init`

**Під роллю:** `pft_test_init`. Але `GRANT … ON ALL TABLES` може виконати лише власник таблиць. Тому:

- якщо таблиці створені під `pft_test_init` (Шлях 1 у Блоці 5) — ВЕСЬ блок під `pft_test_init`:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pft_test_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public            -- сесія сама = pft_test_init; FOR ROLE не потрібен
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pft_test_runtime;  -- превентивно; sequences у схемі немає
```

- якщо таблиці створені під `neondb_owner` (Шлях 2 у Блоці 5) — GRANT `ALL TABLES` виконує `neondb_owner`, а default privileges — під `pft_test_init`:

```sql
-- під neondb_owner:
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pft_test_runtime;

-- під pft_test_init (сесія AS init):
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pft_test_runtime;
```

### Шлях 2 (якщо сесія під `pft_test_init` недоступна взагалі)

**Під роллю:** `neondb_owner` (власник таблиць):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pft_test_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN DATABASE pft_dbtest
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pft_test_runtime;
```

(`FOR ROLE pft_test_init` під `neondb_owner` дасть помилку — `neondb_owner` не є членом `pft_test_init`; саме тому Шлях 2 використовує `FOR ROLE neondb_owner`, чия власність покриває всі таблиці, створені в Блоці 5.)

**Очікування:** всі стейтменти OK.

**STOP якщо:** `WARNING: no privileges were granted` або `permission denied` — перевірити `tableowner` з Блоку 5 і зіставити з обраним шляхом; не змінювати OWNER самостійно — ескалувати.

Контроль після блоку:

```sql
-- усі 43 таблиці мають DML-грант для runtime:
SELECT count(*) FROM information_schema.role_table_grants
WHERE grantee='pft_test_runtime' AND table_schema='public'
  AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');
-- очікування: 43 × 4 = 172

-- default privileges зафіксовані (у контексті pft_dbtest, фільтр за схемою public):
SELECT count(*) FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';
-- очікування: Шлях 1 → 2 (TABLES + SEQUENCES від pft_test_init); Шлях 2 → 1 (TABLES від neondb_owner)
```

---

## Блок 7. Фінальна перевірка доступу runtime-ролі

**7a.** **Де:** будь-яка БД. **Під роллю:** `neondb_owner`.

```sql
SELECT has_database_privilege('pft_test_runtime','pft_dbtest','CREATE'); -- false
SELECT has_schema_privilege('pft_test_runtime','public','CREATE');       -- false
SELECT has_schema_privilege('pft_test_runtime','public','USAGE');        -- true
SELECT has_schema_privilege('pft_test_init','public','CREATE');          -- true
```

**7b. Живий логін під runtime (факультативно, але рекомендовано):** psql під `pft_test_runtime` → `pft_dbtest`:

```sql
SELECT current_database(), current_user;
-- очікування: pft_dbtest | pft_test_runtime
CREATE TABLE t_probe(x int);   -- очікування: permission denied for schema public → правильно
DROP TABLE "User";             -- очікування: must be owner of table "User" → правильно
TRUNCATE "User";               -- очікування: permission denied → правильно
ALTER TABLE "User" ADD COLUMN probe int; -- очікування: must be owner → правильно
SELECT count(*) FROM "User";   -- очікування: 0 (таблиця порожня) → DML працює
```

**7c. Спроба підключитись під runtime до `neondb`:**
Механізм: **окреме psql-з'єднання** з connection string ролі `pft_test_runtime` до бази `neondb`. Neon SQL Editor під `neondb_owner` для цього тесту НЕ придатний — він не може виконувати запити «під runtime».

```sql
-- під pft_test_runtime у контексті neondb:
SELECT current_database();   -- підключення ПРОЙДЕ (залишок Опції A через PUBLIC)
SELECT count(*) FROM "User"; -- очікування: permission denied for table "User" → доступу до даних немає
```

**STOP критерії:**
- 7b: якщо CREATE TABLE/ALTER/TRUNCATE пройшли успішно → runtime має надлишкові права → СТОП і ескалация;
- 7c: якщо `SELECT count(*) FROM "User"` у `neondb` повернув число (а не помилку) → СТОП, це критичний пробіл — ескалувати негайно.

---

## 10. Залишкові невизначеності (BLOCKER-кандидати, не вигадані рішення)

| # | Невизначеність | Статус | Як розв'язується |
|---|---|---|---|
| 1 | Чи має `neondb_owner` ефективне CREATEROLE у цьому проєкті (через членство `neon_superuser`) — агент не міг перевірити (MCP SQL заборонено у цій фазі) | ГЕЙТ у Блоці 0 | Якщо pre-check дає `rolcreaterole=false` + `rolsuper=false` → BLOCKER, ескалация власником до Neon support / Console role management |
| 2 | Чи Neon Console дозволяє сесію під `pft_test_init` («run as role») | НЕ блокує — є формальний Шлях 2 | Власник обирає шлях у Блоках 5–6; обидва описані точно |
| 3 | Історія SQL Editor Console може зберігати текст із паролями | Оброблено §Блок 1 | Очистити історію редактора; паролі ніколи не вносяться у файли/звіти |

Жодна з трьох невизначеностей не вимагає вигаданого рішення: #1 і #2 мають явні STOP-гейти, #3 — процедурне правило.

---

## Фінальний checklist (послідовність + STOP-критерії)

| # | Блок | Де | Під роллю | PASS-критерій | STOP якщо |
|---|---|---|---|---|---|
| 0 | Pre-check | `pft_dbtest` | `neondb_owner` | `NOT (rolsuper OR rolcreaterole)` = false | обидва прапорці false (незалежно від CREATE-на-базу) → BLOCKER |
| 1 | Ролі | `pft_dbtest` | `neondb_owner` | 2 рядки, усі прапорці false, login=true | permission denied → BLOCKER |
| 2 | Права `pft_dbtest` | `pft_dbtest` | `neondb_owner` | 5 стейтментів OK | будь-яка помилка |
| 3 | neondb defense + перевірки | будь-яка; 3.5a — окремий tab до `neondb` | `neondb_owner` | 3.2 → 0 рядків; 3.3 → `=Tc/` на місці; 3.4 → два "true" (PUBLIC), CREATE=false; 3.5a (neondb) → 0; 3.5b (pft_dbtest) → 0 | зникнення `=Tc/` у 3.3 (хтось ревокнув PUBLIC) або будь-яке "true" на CREATE |
| 4 | Членства | будь-яка | `neondb_owner` | 0 рядків | ≥1 рядок → BLOCKER |
| 5 | Init-SQL | `pft_dbtest` | `pft_test_init` (або `neondb_owner`) | 43 таблиці / 34 enum / 140 індексів (97 явних + 43 PK) / 39 FK; 1 notice | `already exists` (крім notice схеми), permission denied, розрив під час файлу |
| 6 | DML + default privileges | `pft_dbtest` | шлях за `tableowner` | 172 грантів; pg_default_acl: 2 (Шлях 1) / 1 (Шлях 2), фільтр schema='public' | WARNING no privileges / permission denied; інша кількість defacl-записів, ніж очікується для обраного шляху |
| 7 | Фінальні перевірки | будь-яка + живий psql | обидві | 7a очікування; 7b — усі DDL-спроби відхилено; 7c — connect OK, SELECT FROM "User" → permission denied | будь-який DDL пройшов під runtime; SELECT у `neondb` повернув дані |
| 8 | Connection strings | Console → Endpoint | — | env-пари в `.env.local` лише локально | рядок у звіті/чаті/логах |
| 9 | Тести (окремий етап) | локально | — | `npm run test:db:gated` → 19/19 PASS | anything інакше |

Загальне правило: **будь-який несподіваний результат — СТОП, фіксувати текст помилки, ескалувати; не імпровізувати REVOKE/GRANT/OWNER-зміни.** Опція B не виконується в межах цього runbook.
