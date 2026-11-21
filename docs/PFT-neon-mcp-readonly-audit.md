# PFT — Neon MCP Read-Only Verification

Дата: 2026-11-13
Метод: виключно read-only MCP tools (сервер підключено з `?readonly=true` + категорії `querying`, `schema`). Жодних змін у БД чи конфігурації не внесено. Секрети не друкувалися.

---

## MCP Authentication — PASS

- У конфігурації `mcp.Neon` **немає** заголовків (`headers: none`) і **немає** auth-параметра в URL — тобто немає ні старого `Authorization`-заголовка з API key, ні `api-key` query-параметра.
- Автентифікація працює через **OAuth** (opencode зберігає лише URL; токен — в OAuth-кеші агента, не в конфізі). Це відповідає рекомендованому патерну skill-а (`neon mcp --oauth`-стиль): «store only the server URL».
- Непрямий доказ, що це OAuth-сесія з обмеженим scope: інструментів списку проєктів немає (project-scoped connection їх ховає), і сервер підключено з фіксованим `projectId=curly-hill-43179499`.
- Токени не читалися і не виводилися.

**Статус: PASS** (OAuth; старий API-key канал відсутній).

## MCP Configuration — PASS

Прочитано `C:\Users\User\.config\opencode\opencode.json` → `mcp.Neon`:

| Перевірка | Очікування | Факт | Статус |
|---|---|---|---|
| URL містить `readonly=true` | так | `readonly=true` | **PASS** |
| Категорії | `querying` + `schema` | `category=querying`, `category=schema` (два параметри) | **PASS** |
| Project ID | `curly-hill-43179499` | `projectId=curly-hill-43179499` | **PASS** |
| Без Authorization/API-key header | відсутній | `headers: none` | **PASS** |
| Сервер увімкнений | enabled | `type=remote, enabled=true`, host `mcp.neon.tech`, path `/mcp` | **PASS** |

Наслідок scope: у каталозі доступні **лише 9 read-only інструментів** (write-інструменти відсутні — write-mode попередній стан 141 інструмента не відновлено; це цілеспрямована конфігурація).

## Available Tools — PASS (9/9)

| # | Tool | Можливості |
|---|---|---|
| 1 | `compare_database_schema` | Диф схеми між базами/гілками (в т.ч. point-in-time) |
| 2 | `describe_table_schema` | Колонки, індекси, констрейнти, розміри однієї таблиці |
| 3 | `explain_sql_statement` | Execution plan (JSON); `analyze` виконує запит — не використовувався |
| 4 | `get_database_tables` | Список таблиць/view поза системними схемами |
| 5 | `inspect_database` | Read-only перевірки `neon inspect db` (outliers, lfc-hit-rate, working-set тощо) |
| 6 | `list_incidents` | Відкриті інциденти Neon з neonstatus.com (без credentials) |
| 7 | `list_slow_queries` | Повільні запити з `pg_stat_statements` |
| 8 | `run_sql` | Один SQL-стейтмент на БД гілки, тільки SELECT (сервер форсує read-only) |
| 9 | `send_feedback` | Анонімний фідбек Neon (не використовувався) |

Використані: `run_sql`, `get_database_tables`, `describe_table_schema`. `explain` з `analyze`, `inspect_database`, `compare_database_schema`, `send_feedback` — не викликалися (не потрібні або потенційно виконавчі).

## Project Identity — PASS

- Проєкт `curly-hill-43179499` відповідає на запити через MCP з явним `project_id`.
- Гілка за id `br-dry-rain-b4p49oe4` (закріплена в `.neon` як `preview`) відповідає на всі запити — id валідний у цьому проєкті.
- Server identity (з живого запиту в `pft_dbtest`): `PostgreSQL 18.7 (a21afb5) on aarch64-unknown-linux-gnu`.

## Preview Branch — PASS

Гілка `preview` (`br-dry-rain-b4p49oe4`) існує і доступна: `run_sql` та обидва schema-інструменти повернули дані саме з неї.

## Database Inventory — PASS

`SELECT datname FROM pg_database WHERE NOT datistemplate` на гілці `preview` (з'єднання в `neondb`):

| База | datallowconn | Призначення |
|---|---|---|
| `neondb` | true | Основна база гілки (схема PFT + demo) |
| `pft_dbtest` | true | **Ізольована тестова база — присутня** |
| `postgres` | true | Системна |

**`pft_dbtest` існує саме в гілці `preview` — підтверджено живим запитом, не за назвами scopes.**

## pft_dbtest Schema Inventory — PASS (порожня, це очікувано)

- `get_database_tables` для `pft_dbtest` → **порожній список**: жодної таблиці/view поза системними схемами. Це узгоджується з PHASE 1.16: база створена власником як **порожня**, схема ще не ініціалізована (план ініціалізації — у `docs/PFT-phase-1.16-report.md`).
- Жива identity-перевірка (read-only): `current_database()=pft_dbtest`, `current_user=neondb_owner`, `current_schema()=public`.
- Для контрасту: `neondb` на тій же гілці містить повну схему PFT (29 таблиць: User, TradingAccount, Payout, AuditLog, Trade, …) + demo-таблиці `live_notes` (id PK, body text, created_at timestamptz) і `playing_with_neon`.

## Production Isolation — PARTIAL (дві окремі речі)

**1. Ізоляція `pft_dbtest` від `neondb` у межах гілки — PASS (структурний рівень).**
- Це **окремі бази одного Postgres-кластера** (різні `datname`, не different-scheme синоніми): доведено живим `current_database()` та окремими інвентаризаціями (`neondb` — 31 таблиця; `pft_dbtest` — 0).
- Postgres фізично не дозволяє сесії в одній базі читати об'єкти іншої (cross-database queries неможливі) — це engine-гарантія, а не угода за назвами.
- Доступ по ролях: у кластері існують `cloud_admin`, `neon_service`, `neon_superuser`, `neondb_owner`, `token_roles`. Поточне підключення MCP у `pft_dbtest` іде під `neondb_owner` (rolcreatedb=true, не superuser) — тобто роль-план із PHASE 1.16 (`pft_test_init`/`pft_test_runtime` з `REVOKE ALL ON DATABASE neondb`) **ще не застосований**: окремих least-privilege ролей немає.

**2. Ізоляція гілки `preview` від Production гілки/бази — UNVERIFIED через MCP.**
- Production PFT-бази живе в **іншому Neon-проєкті** (`ep-jolly-resonance`), а не в `curly-hill-43179499` — уже сам факт, що MCP-підключення жорстко запінено на `projectId=curly-hill-43179499`, унеможливлює доступ тестового шляху до Production через цей канал. Це сильний структурний аргумент.
- Але в межах `curly-hill` не видно списку гілок (write-інструменти/project-level tools відсутні в read-only категоріях), тому повне дерево гілок і дефолтну гілку довести через MCP неможливо. Висновок лише частковий.

**Загальний статус: PARTIAL** — ізоляція бази від бази доведена; ізоляція гілки/проєкту від Production доведена лише структурно (projectId-pinning), не повністю.

## Blockers and Next Steps

| # | Пункт | Статус | Наступний безпечний крок |
|---|---|---|---|
| 1 | OAuth замість API key | PASS | — |
| 2 | readonly + querying/schema + projectId | PASS | — |
| 3 | 9 read-only tools | PASS | — |
| 4 | Проєкт доступний | PASS | — |
| 5 | Гілка `preview` доступна | PASS | — |
| 6 | `pft_dbtest` існує в гілці | PASS | — |
| 7 | Схема `pft_dbtest` | PASS (порожня) | Ініціалізація за планом G з `docs/PFT-phase-1.16-report.md` (`prisma migrate diff --from-empty … --script`, застосування під `pft_test_init`) |
| 8 | Ізоляція `pft_dbtest`↔`neondb` | PASS (engine-рівень) | — |
| 9 | Ролі `pft_test_init`/`pft_test_runtime` | **UNVERIFIED / відсутні** | Owner виконує SQL-план F (PHASE 1.16) у Neon Console; MCP-канал read-only і для цього не годиться |
| 10 | Повна ізоляція гілки preview від Production | PARTIAL | Owner підтверджує дерево гілок у Console; за потреби read-only перевірка через CLI/Console, не через цей MCP |

**Рекомендація щодо наступного безпечного кроку:** залишити MCP у поточному read-only стані (безпечний інструмент аудиту — не міняти конфігурацію), виконати owner-дії PHASE 1.16 (роль-план F + ініціалізація схеми G), після чого повторити identity-перевірку `pft_dbtest` через read-only `run_sql` (`current_database()`, `current_user` — очікування після role-плану: `current_user = pft_test_runtime`).

Жодних змін у базі даних чи конфігурації не внесено: усі запити — SELECT/списання схем; конфіг прочитаний, не модифікований.
