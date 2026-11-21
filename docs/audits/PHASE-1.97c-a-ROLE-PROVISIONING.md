# PHASE 1.97c-a — Migration Role Provisioning Preflight (DB-free)

Дата: 2026-11-17. Статус: **READY FOR OWNER REVIEW** (жодного підключення до БД, жодних змін ролей/grants).

**Оновлення (PHASE 1.97c-e):** draft оновлено до **v3** за результатами аудитів 1.97c-b/c/d. Ключові зміни v3: окремі власники 4 таблиць (`<OWNER_OF_*>`), membership `WITH INHERIT TRUE, SET TRUE` per-owner, PG≥16 guard (`server_version_num`), port/runtime-marker перевірки, 8-об'єктний teardown з індивідуальними власниками, explicit REVOKE по гранторах, recovery-матриця R1–R8, без REASSIGN OWNED / DROP OWNED, секції A (admin) / B (owners) / C (teardown) / D (REVOKE) / E (admin-only) / R (recovery). Деталі семантики — у звітах 1.97c-c і 1.97c-d.

**Оновлення (PHASE 1.97c-f):**
1. **Neon capability finding (офіційні docs, 2026-11-17):** `neondb_owner` та ролі з Console/CLI — члени NOLOGIN-ролі `neon_superuser` (CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION), але **це НЕ superuser** (Neon забороняє superuser-з'єднання). Отже «admin-обхід ownership checks» із матриці 1.97c-d (рядок 5) **недоступний** — усі `ALTER … OWNER TO` виконуються per-owner шляхом (membership A.3, INHERIT TRUE + SET TRUE). CREATEROLE дозволяє створення ролі та дає ADMIN OPTION творцю (PG16+), тому D-REVOKE membership і DROP ROLE у секції E виконувані — **LIVE VERIFICATION REQUIRED**. `neon_superuser` ALTER-нути або зробити власником БД неможливо (заборонено Neon).
2. **Fail-closed provisioning executor** створено: `scripts/provision-test-migrator-197cf.ts` (+ 21 DB-free тест). Секції `pre | A | B | C | D | E | teardown-check`; один connection, TLS до першого SQL, без retry/reconnect, без довільного SQL, відмова при незаповнених placeholders, параметри `MIGRATION_OWNER_USER/ORDER/BASELINE/TRADING`, `MIGRATION_ROLE_PASSWORD` (секція A). Мульти-власник → секції B/C/D відмовляються (вимагають ручний запуск по одному власнику).
3. **Preflight режими**: `--mode pre | post | teardown` у `scripts/migration-preflight-197c.ts` (все read-only); `pre` підключається як admin/owner і не вимагає існування `pft_test_migrator`; `post` перевіряє membership/ownership; `teardown` — 8 restore-цілей, CREATE у цільових власників, DROP ROLE readiness.
4. Draft доповнено Neon-аддендумом і recovery-розширенням T0–T4 (прогрес ownership-трансферів 0–4).

**Оновлення (PHASE 4.5 — PostgreSQL 18 creator membership):**
Створення кожної нової роли не-superuser роллю з CREATEROLE автоматично дає творцю membership у створеній ролі. Вузький дозволений pattern:

| Granted role | Member | ADMIN | INHERIT | SET |
|---|---|---:|---:|---:|
| `pft_test_migrator` | `neondb_owner` | TRUE | FALSE | FALSE |
| `pft_test_runtime` | `neondb_owner` | TRUE | FALSE | FALSE |

Цей membership не видаляється і не змінюється як side effect provisioning-а. Перевірка uses exact role names plus role OIDs and rejects every other membership involving either target role. Runtime/migrator cannot be members of each other, must not have additional members, and cannot gain `INHERIT TRUE` or `SET TRUE`.

ADMIN OPTION is control-plane authority: `neondb_owner` can grant membership in each created role to other roles or administer that membership. It does **not** inherit the target role's privileges and does **not** provide `SET ROLE` because `INHERIT=false` and `SET=false`. This exception must not be described as harmless or as an application privilege. It does not change the test roles' own attributes or grant runtime schema/table privileges.

**Оновлення (Phase 4 FINAL — Neon plaintext password compatibility):**
`CREATE ROLE` provisioning must send a plaintext password to Neon. SCRAM verifiers, shell interpolation, and process arguments are forbidden. The executor formats PostgreSQL DDL through a server-side parameterized `SELECT format(..., $1, $2, $3)`, then executes the resulting fixed utility statement. The password is supplied only by the pg parameter path and transiently generated Credential Manager storage. Sanitized diagnostics redact passwords and connection URLs. Cleanup is attempted on success and failure.

## 1. SQL-операції по кожній міграції (аналіз фактичних файлів, не назв)

| Міграція | Операції | Таблиця-ціль |
|---|---|---|
| checkout-identity.sql | `LOCK TABLE … SHARE ROW EXCLUSIVE`; SELECT (duplicate check у DO-блоці); `UPDATE "User" SET email = lower(trim(email))`; `CREATE UNIQUE INDEX "User_email_lower_key"` | User (існуюча) |
| checkout-intent.sql | `CREATE TYPE "CheckoutIntentStatus"` (DO, duplicate_object → NULL); `CREATE TABLE "CheckoutIntent"`; 3 × CREATE INDEX на ній; `ALTER TABLE "Order" ADD COLUMN "checkoutIntentKey" TEXT`; CREATE INDEX на Order | CheckoutIntent (нова), Order (існуюча) |
| payment-recovery.sql | `CREATE TYPE "PaymentRecoveryStatus"`; `CREATE TABLE "PaymentRecovery"` з FK → Order (ON DELETE/UPDATE CASCADE); 2 × CREATE INDEX; `INSERT … SELECT` backfill з `ON CONFLICT ("orderId") DO NOTHING` | PaymentRecovery (нова), Order (читання) |
| ledger-baseline-watermark.sql | 2 × `ALTER TABLE "AccountLedgerBaseline" ADD COLUMN IF NOT EXISTS` (nullable) | AccountLedgerBaseline (існуюча) |
| inactivity-closure-claim.sql | 4 × `ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS` (одна NOT NULL DEFAULT 0); `CREATE INDEX "TradingAccount_inactivityClosureClaimedAt_idx"` | TradingAccount (існуюча) |

## 2. Точні PostgreSQL-привілеї

| Операція | Потрібний привілей | Семантика |
|---|---|---|
| CREATE TYPE | `CREATE` на схемі public | об'єкт належить створювачу |
| CREATE TABLE | `CREATE` на схемі public | нова таблиця належить створювачу |
| CREATE [UNIQUE] INDEX на існуючій таблиці | **власність таблиці** (GRANT недостатньо) | non-owner не може будувати індекс |
| ALTER TABLE ADD COLUMN | **власність таблиці** (GRANT недостатньо) | ALTER — тільки owner |
| LOCK TABLE … SHARE ROW EXCLUSIVE | `UPDATE` на таблиці (або власність) | |
| UPDATE "User" | `UPDATE` на User | |
| INSERT INTO нову таблицю | `INSERT` (автоматично у власній таблиці) | |
| INSERT … SELECT з Order | `SELECT` на Order | |
| FOREIGN KEY → Order | `REFERENCES` на Order (або власність) | |
| CREATE у базі | **не потрібен** (усі об'єкти у схемі public) | |

Superuser/CREATEDB/CREATEROLE/BYPASSRLS — **не потрібні і не рекомендуються**.

## 3. Вимоги власності

`ALTER TABLE` (2 міграції) та `CREATE INDEX` (3 міграції) на чотирьох існуючих таблицях вимагають **власності**, яку неможливо замінити жодним GRANT:
`User`, `Order`, `AccountLedgerBaseline`, `TradingAccount`.

Це означає: **варіант A (лише GRANT) гарантовано не виконає міграції.** Мінімальних привілеїв без delegation не існує — це вказано прямо, без вигаданих grants. Власність на 4 таблиці на час виконання + відкликання після — обов'язкова.

## 4. Варіант A vs B

**A. Тимчасова роль з GRANT-only.**
Права: LOGIN, CREATE на public, SELECT/UPDATE/REFERENCES. Переваги: нуль дотику до власності, найменша поверхня. Ризик: міграції впадуть на `ALTER TABLE`/`CREATE INDEX` (permission denied) — фаза не виконається. Rollback: REVOKE + DROP ROLE. Не потребує адміністратора Neon, але не здатна досягти мети.

**B. Тимчасове делегування ownership (рекомендовано).**
Права: A + `ALTER TABLE … OWNER TO pft_test_migrator` для 4 таблиць (виконує поточний owner/admin), після міграцій — повернення власності (`REASSIGN OWNED` + `OWNER TO <ORIGINAL_OWNER>`, включно з новими таблицями й enum-типами), `DROP OWNED`, `DROP ROLE`. Переваги: гарантовано достатньо; права існують мінімально необхідний час. Ризики: тимчасова зміна власників (ризик для RBAC-інтроспекції, якщо хтось читає tableowner у вікно), власник має бути живим на момент повернення. Rollback повний і прописаний. Потребує однієї дії поточного власника таблиць (може бути Neon admin).

## 5. Рекомендований варіант

**B** — з жорстким протоколом: делегувати власність безпосередньо перед виконанням міграцій, повернути негайно після postflight, роль `pft_test_migrator` **видалити** після виконання (не залишати постійним об'єктом). Роль не має жодних атрибутів, крім LOGIN, `CONNECTION LIMIT 2`.

## 6. SQL draft для власника

`prisma/sql/test-role-provisioning.draft.sql` (новий файл, **НЕ** частина списку п'яти міграцій executor-а, не виконується агентом):
- Pre-checks: `current_database() = 'pft_dbtest'` інакше EXCEPTION; роль не існує; базові таблиці присутні.
- `CREATE ROLE pft_test_migrator LOGIN PASSWORD '<SET_BY_OWNER>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 2`.
- Grants: `USAGE`+`CREATE` на public; `SELECT` на 4 таблиці; `UPDATE` на User (LOCK/UPDATE); `REFERENCES` на Order.
- Ownership delegation: 4 × `ALTER TABLE … OWNER TO pft_test_migrator` (`<ORIGINAL_OWNER>` зафіксувати запитом до делегування).
- Post-checks: роль існує; власність делегована; `has_schema_privilege('pft_test_migrator','public','CREATE')`.
- Окремий блок "після міграцій": `REASSIGN OWNED` → повернення власників → `ALTER TYPE … OWNER` (2 enum-типи) → `DROP OWNED` → `DROP ROLE`.
- Rollback план для скасування самого provisioning.

## 7. Revoke/drop план

Див. розділ 5 draft-файлу: `REASSIGN OWNED BY pft_test_migrator TO <ORIGINAL_OWNER>;` → 4 × `ALTER TABLE … OWNER TO <ORIGINAL_OWNER>;` → 2 × `ALTER TYPE … OWNER TO <ORIGINAL_OWNER>;` → `DROP OWNED BY pft_test_migrator;` → `DROP ROLE IF EXISTS pft_test_migrator;` (роль не дропнеться, доки володіє об'єктами — саме тому REASSIGN перший). `pft_test_runtime` ніколи не змінюється.

## 8. DB-free validation

- `scripts/test-role-provisioning-197ca.test.ts`: 8 статичних тестів (заборона атрибутів, відсутність секретів/URL, TEST-only guard, рівно 4 delegation, точний набір grants, revoke-план, рівно 5 міграцій, executor не чіпає draft) — **pass**.
- `tsc --noEmit` 0; ESLint 0; `git diff --check` чисто; жодної команди, що виконує SQL або підключається до БД.

## 9. Ризики та невирішені питання

1. `<ORIGINAL_OWNER>` потрібно зафіксувати живим запитом під час provisioning (DB-free не може знати власників).
2. Вікно делегованої власності: не запускати інші деплої/міграції паралельно (advisorу lock в executor-і захищає від конкуренції executor-ів, але не від чужих DDL).
3. `CONNECTION LIMIT 2` — страховка; executor використовує один connection.
4. Якщо Neon admin не віддає право `ALTER TABLE OWNER` поточному власнику — питання до власника Neon (єдине невирішене).
5. Роль буде створена з паролем власника — вводити лише у shell/env, не в чат.
