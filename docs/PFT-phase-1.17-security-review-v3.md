# PFT — PHASE 1.17: Security Review v3 — PUBLIC на `neondb`, ізоляція тестових ролей

Дата: 2026-11-13
Статус плану v3: **READY FOR OWNER EXECUTION** (Опція A, за замовчуванням). Строгий варіант (Опція B) — окреме явне рішення власника.
Метод: read-only MCP SELECT-и (проєкт `curly-hill-43179499`, гілка `preview` `br-dry-rain-b4p49oe4`). Жодних змін у Neon, ролях, grants, Production, MCP.

---

## A. Виправлення трьох дефектів v2

| # | Дефект v2 | Що невірно | Виправлення v3 |
|---|---|---|---|
| 1 | «`REVOKE ALL ON DATABASE neondb FROM roles` блокує neondb» | REVOKE діє лише на явні ACL-записи ролі; PUBLIC-права (`=Tc/`) він не зачіпає, а негативних грантів у Postgres не існує | семантика уточнена; PUBLIC на `neondb` не ревокається автоматично (розділ C/D); defense-in-depth REVOKE залишено |
| 2 | Фільтр `pg_auth_members` по `r.rolname` | `r` = granted role (ким керують), `m` = member (хто успадковує); перевірка v2 шукала «хто володіє тестовими ролями», а не «у що входять тестові ролі» | фільтр `m.rolname IN ('pft_test_init','pft_test_runtime')`, очікування 0 рядків |
| 3 | `has_database_privilege('public','pft_dbtest','CONNECT')` | `public` — це schema, а не роль; має бути `PUBLIC` (псевдо-роль у ACL-записах, але не валідний аргумент `has_database_privilege` у всіх версіях) | пряме читання `pg_database.datacl`: `NULL` = дефолт (PUBLIC CONNECT+TEMP), запис `=Tc/<grantor>` = PUBLIC TEMPORARY+CONNECT; додатково перевіряється `has_database_privilege('<test_role>','neondb',…)` — ефективний облік PUBLIC самим Postgres |

## B. Фактичні права (виміряно read-only MCP)

### B.1. Рівень баз даних (`pg_database.datacl`)

| База | datacl | Значення для PUBLIC |
|---|---|---|
| `neondb` | `=Tc/neondb_owner \| neondb_owner=CTc/… \| neon_superuser=CTc/…` | **CONNECT + TEMPORARY** (запис `=Tc/`) |
| `pft_dbtest` | `NULL` | дефолт: **CONNECT + TEMPORARY** |

### B.2. Схема `public` (обидві бази)

`pg_database_owner=UC/pg_database_owner | =U/pg_database_owner` — PUBLIC має **USAGE**, **CREATE немає** (у v2/v3 REVOKE на схему `pft_dbtest` — захисне закріплення цього стану).

### B.3. Таблиці / sequences

- `information_schema.role_table_grants WHERE grantee='PUBLIC'` → **0** у `neondb`, **0** у `pft_dbtest`.
- Sequences відсутні обидві бази (0 `CREATE SEQUENCE` в init-SQL; 0 `autoincrement` у схемі Prisma).
- `pg_default_acl`: `neondb` — 2 записи (існуючі), `pft_dbtest` — 0.

### B.4. Ролі та членства

| Роль | Атрибути | Членство (member → granted) |
|---|---|---|
| `cloud_admin` | SUPERUSER | — (bypass ACL, поза впливом будь-яких REVOKE) |
| `neon_service` | CREATEDB, CREATEROLE, NO явного запису в datacl `neondb` | `neon_service → neon_superuser` |
| `neon_superuser` | rolinherit=false, член pg_monitor/pg_read_all_data/pg_write_all_data/pg_maintain тощо | — |
| `neondb_owner` | — | `neondb_owner → neon_superuser` |
| `token_roles` | NOLOGIN | — |

Повний список членств — 12 записів, жодного з них неможливо «заразити» новою тестовою роллю (нові ролі починають без членств).

## C. Аналіз: чи можна заблокувати доступ тестових ролей до `neondb`, не зачепивши чинних користувачів?

**Проблема:** у Postgres **немає негативних грантів**. Скасувати CONNECT для двох конкретних ролей, коли він наданий PUBLIC, можна лише одним способом — ревокнути його в PUBLIC у всіх.

**Чому «ревокнути у PUBLIC» — не безкоштовна дія (impact на чинних користувачів `neondb`):**

1. **`neon_service`** — головний зачіплений користувач. У datacl `neondb` у нього **немає явного запису** ⇒ він підключається до `neondb` **виключно через PUBLIC CONNECT**. `REVOKE CONNECT … FROM PUBLIC` **одразу ламає** підключення `neon_service` до `neondb`, поки власник не виконає `GRANT CONNECT ON DATABASE neondb TO neon_service`. Це може зупинити службові процеси Neon/додатків, що використовують цю роль.
2. **`neondb_owner`** — має явний `CTc` ⇒ не постраждає.
3. **`neon_superuser`** — явний `CTc` ⇒ не постраждає.
4. **Будь-які майбутні/невідомі login-ролі акаунта** ( ایجاد вручну власником або сервісами Neon) — втратять можливість підключатися до `neondb` доти, доки їм не видадуть явний CONNECT.
5. **TEMPORARY** для PUBLIC: після ревоки жодна роль без явного TEMP не зможе створювати temp-таблиці в `neondb` (на практиці рідко використовується, але це теж зміна поведінки).

**Висновок C:** безпосередньо, автоматично ревокнути PUBLIC на `neondb` — **не можна** без ризику для `neon_service` та майбутніх ролей. Але і **не обов'язково** для цілей ізоляції даних: PUBLIC у `neondb` не має жодного гранту на таблиці (B.3), схема public — лише USAGE. CONNECT без table-grant дає лише підключення, яке не читає і не пише дані (перевіряється тестом 4.4 плану v3).

## D. Два варіанти для власника

### Опція A — за замовчуванням (рекомендована): PUBLIC на `neondb` не чіпається

- У `pft_dbtest`: PUBLIC-права прибираються повністю (CONNECT, TEMPORARY, USAGE, CREATE).
- У `neondb`: лишаються дефолтні PUBLIC CONNECT+TEMPORARY; тестові ролі формально можуть підключитися, але не мають доступу до даних (0 PUBLIC table grants, USAGE-only схема).
- Defense-in-depth `REVOKE ALL ON DATABASE neondb FROM pft_test_init, pft_test_runtime` залишається — він прибирає будь-які майбутні *явні* ACL-записи цих ролей.
- **Residual ризик (прийнятий, документований):** тестові ролі зберігають CONNECT+TEMPORARY на `neondb`. Наслідки: можливість підключитися та створювати temp-таблиці у `neondb`; доступу до даних — немає (доведено B.3, перевіряється 4.4). Легкий шум у `pg_stat_activity` Neon — на практиці несуттєво.
- **Зміни для чинних користувачів/застосунків: нуль.**

### Опція B — строгий варіант (тільки за явним рішенням власника)

```sql
-- ПЕРЕД ревоко — обов'язково:
GRANT CONNECT ON DATABASE neondb TO neon_service;
-- (та будь-яким іншим ролям, які власник ідентифікує як тих, що підключаються до neondb)
-- Після цього:
REVOKE CONNECT, TEMPORARY ON DATABASE neondb FROM PUBLIC;
```

**Обов'язкові owner-рішення перед виконанням Опції B:**

1. Підтвердити, що `neon_service` — єдиний неявний споживач PUBLIC CONNECT на `neondb` (перевірити додатки/Vercel-строки підключення на предмет інших ролей).
2. Виконати `GRANT CONNECT … TO neon_service` ДО ревоки (послідовність у SQL вище).
3. Прийняти, що всі майбутні ролі потребуватимуть явного CONNECT для роботи з `neondb`.
4. Після ревоки повторити перевірки 4.1–4.3 плану v3: `has_database_privilege('pft_test_*','neondb','CONNECT')` → **false**; datacl `neondb` міститиме `neon_service=c/…` і не міститиме `=Tc/…`.

**Чому Опція B не є обов'язковою для статусу READY:** вимога ізоляції тестів досягається на рівні даних (тести не чіпають `neondb` ні кодом, ні конфігом; гейт фіксує URL/базу/роль; 0 PUBLIC-грантів у `neondb` доведено вимірюванням). Публічний CONNECT без грантів на об'єкти не є шляхом до даних.

## E. Перевірки з брифінгу (пункт C) — підсумок

| Пункт | Стан у v3 |
|---|---|
| CONNECT | `pft_dbtest`: явний для обох тестових ролей, PUBLIC ревокнуто. `neondb`: залишок через PUBLIC (Опція A) або false (Опція B) |
| TEMPORARY | те саме |
| CREATE на базу | false для обох ролей на обох базах (не власники БД) |
| права PUBLIC | datacl-перевірка замінює невалідний `has_database_privilege('public',…)` |
| успадковані членства | `pg_auth_members` з фільтром `m.rolname` → 0 рядків |
| INHERIT та атрибути | NOSUPERUSER/NOCREATEDB/NOCREATEROLE явні; INHERIT=true (достатньо; членств немає — успадковувати нічого) |
| схема public | PUBLIC: ревокнуто USAGE/CREATE у `pft_dbtest`; у `neondb` лишається USAGE-only (без CREATE — доведено) |
| таблиці/sequences | runtime: SELECT/INSERT/UPDATE/DELETE на 43 таблиці + default privileges; sequences відсутні (грант превентивний) |
| default privileges (пункт E) | застосовуються лише до об'єктів, створених відповідною роллю після виконання; крок 4 GRANT ALL TABLES покриває існуючі 43; два шляхи виконання (Шлях 1 — сесія AS `pft_test_init`, Шлях 2 — від імені `neondb_owner`) описані у плані v3 розділ 2 |
| CREATE init-SQL без власності БД (пункт F) | так — єдині ALTER у файлі: 39× `ALTER TABLE ADD CONSTRAINT`; власності схеми (CREATE) достатньо; нуль ALTER DATABASE/ROLE/COMMENT/SECURITY DEFINER/EXTENSION/FUNCTION/TRIGGER |
| `ALTER DEFAULT PRIVILEGES FOR ROLE pft_test_init` (пункт G) | неможливо під `neondb_owner` без членства у `pft_test_init`; розв'язано Шляхом 1/2 (розділ 2 плану v3) |

## F. Дії, що можуть вплинути на інших користувачів/застосунків (окремий розділ звіту)

| Дія | Вплив на інших | Де |
|---|---|---|
| `REVOKE CONNECT, TEMPORARY ON DATABASE pft_dbtest FROM PUBLIC` | **Немає** — `pft_dbtest` порожня тестова база; жоден чинний застосунок її не використовує (0 таблиць, 0 грантів) | безпечно |
| `REVOKE USAGE, CREATE ON SCHEMA public` у `pft_dbtest` | **Немає** — база порожня | безпечно |
| `REVOKE ALL ON DATABASE neondb FROM pft_test_*` | **Немає** — знімає лише явні записи самих тестових ролей (їх немає) | безпечно |
| `CREATE ROLE pft_test_*` | **Немає** — нові ролі без членств, без впливу на існуючі | безпечно |
| `GRANT`/`ALTER DEFAULT PRIVILEGES` у `pft_dbtest` | **Немає** — лише всередині тестової бази | безпечно |
| **Опція B: `REVOKE CONNECT, TEMPORARY ON DATABASE neondb FROM PUBLIC`** | **Є вплив:** ламає `neon_service` (поки не видано явний CONNECT), позбавляє PUBLIC-доступу всі майбутні ролі | лише за явним рішенням власника, після GRANT `neon_service` |

## G. Фінальний вердикт

**READY FOR OWNER EXECUTION** — за Опцією A (за замовчуванням):

- Захист даних `neondb` від тестових ролей доведено: 0 PUBLIC table grants, схема public без CREATE, REVOKE defense-in-depth, перевірки 4.1–4.3 v3.
- Резидуальний доступ CONNECT+TEMPORARY тестових ролей до `neondb` через PUBLIC — документований залишок; не є шляхом до даних; усунення — добровільна Опція B з обов'язковими owner-рішеннями (rозділ D).
- Планові SQL-зміни у `pft_dbtest` не впливають на жодного чинного користувача чи застосунок.
