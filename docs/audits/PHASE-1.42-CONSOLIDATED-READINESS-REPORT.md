# PHASE 1.42 — CONSOLIDATED READINESS REPORT (A–I)

Status date: 2026-11-15 · Scope: `scripts/db-prestage/first-run-readiness.ps1` ·
This document consolidates PHASE 1.42-A through 1.42-I. It is **not** an authorization to run
`-Mode Run`.

Пояснення (укр): цей звіт об'єднує дев'ять фаз підготовки першого readiness-з'єднання з тестовою БД
Neon. Кожне твердження позначено як `INDEPENDENTLY VERIFIED` (перевірено на фактичному коді під час
фаз 1.42-C/H/I) або `OWNER-PROVIDED RESULT` (вивід запуску, переданий власником).

---

## A. Executive Summary

Мета — довести readiness тільки локально-верифікованими засобами перед першим мережевим
readiness-only запуском до тестової бази `pft_dbtest` (Neon) під роллю `pft_test_runtime`:
канонічний psql 17.12, TLS `verify-full`, локальний `pgpass.conf`, жодних SQL, жодних секретів у
логах, fail-closed вердикт.

Початкові проблеми: перший мережевий запуск завершився `BLOCKED-cleanup` — `\conninfo` взагалі не
надсилався у stdin; друга спроба після виправлень завершилась `ConsumerTimeout` (30 с) з
непідтвердженою першопричиною (гіпотези: stdout-буферизація psql у пайпі — LIKELY; зависання
connection attempt — POSSIBLE).

Що виправлено: доставка `\conninfo` через stdin, збереження первинного статусу при помилці
cleanup, впорядкований ідемпотентний cleanup, класифікація connect/auth/TLS-помилок до і після
readiness, 12-умовний fail-closed verdict (`Get-RunVerdict`), post-readiness stderr-класифікація,
natural-exit timeout з окремим статусом, діагностичний capture (`DiagLog`), post-consumer drain,
`PGCONNECT_TIMEOUT=10` (child-only), санітизація (включно з `password : value` та URI-credentials).

Поточний стан: локальна реалізація та синтетична валідація — **85/85 PASS, `VALIDATE PASSED`**.

Що ще не підтверджено мережею (UNVERIFIED): реальний формат `\conninfo`, буферизація stdout psql у
пайпі, фактичний TLS/auth handshake, RuntimeDll snapshot у живому psql.

---

## B. Phase History A–I

| Phase | Проблема / завдання | Результат | Статус |
|---|---|---|---|
| 1.42-A | Forensic першого запуску (`BLOCKED-cleanup`) | `\conninfo` ніколи не надсилався; ConsumerTimeout перезаписував cleanup; SQL=0, залишків немає | INDEPENDENTLY VERIFIED (код) |
| 1.42-B | Виправлення F1–F6 (доставка conninfo, primary, cleanup, класифікація, регресія, діагностика) | Впроваджено `Send-StdinLine`, `Invoke-OrderedCleanup`, `Get-FinalStatus`, R1–R12 | INDEPENDENTLY VERIFIED |
| 1.42-C | Reconciliation кількості тестів | Фактично 42 тести (T14/S16/R12), «34/34» — арифметична помилка звіту B; маркер-гарантії доведені статично | INDEPENDENTLY VERIFIED |
| 1.42-D | Post-readiness integrity: 12-умовний PASS-гейт | `Get-RunVerdict`, post-readiness stderr-класифікація, natural-exit window, N1–N14, перейменування T1-constants→T14 | INDEPENDENTLY VERIFIED |
| 1.42-E | Фінальний read-only pre-run аудит | `READY FOR EXPLICIT OWNER AUTHORIZATION` | INDEPENDENTLY VERIFIED |
| 1.42-F | Forensic другого запуску (ConsumerTimeout, 30 с) | Root cause NOT CONFIRMED; stdout-буферизація LIKELY, hang POSSIBLE; втрачено post-consumer дані | INDEPENDENTLY VERIFIED (код) + OWNER-PROVIDED RESULT (вивід запуску) |
| 1.42-G | Діагностика: DiagLog, post-consumer drain, PGCONNECT_TIMEOUT=10 | Матриця 77/77 PASS; D1–D21 | INDEPENDENTLY VERIFIED |
| 1.42-H | Security + lifecycle статичний аудит | Знахідка: gap санітизації `password : value` (некритична); вердикт/lifecycle без дефектів | INDEPENDENTLY VERIFIED |
| 1.42-I | Redaction hardening | `Sanitize` закриває `=`/`:` з пробілами; URI fail-safe; матриця 85/85 PASS | INDEPENDENTLY VERIFIED |

Причинно-наслідковий ланцюг: (1) перший запуск → BLOCKED-cleanup; (2) forensic → `\conninfo` не
надсилався; (3) другий запуск → ConsumerTimeout; (4) root cause непідтверджений; (5) додано
діагностику, drain і connection timeout; (6) security/lifecycle аудит; (7) виправлено redaction;
(8) локальна матриця 85/85 PASS. Невдалі спроби не приховано.

---

## C. Final Architecture

- **Static allowlist** (константи скрипта, єдине джерело параметрів psql):
  `host=ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech`, `db=pft_dbtest`,
  `user=pft_test_runtime`, `port=5432` — перевірено consumer'ом на фактичному виводі `\conninfo`.
- **psql 17.12** — `C:\Program Files\PostgreSQL\17\bin\psql.exe`, SHA-256 перевіряється preflight'ом
  (очікуваний хеш фіксований константою); аргументи `-X -w` (без startup-файлів, без password-prompt),
  interactive stdin, без `-c`/`-f`.
- **TLS `verify-full`** через env `PGSSLMODE` + `PGSSLROOTCERT` → CA bundle
  `scripts/db-prestage/ca/cacert.pem` (SHA-256 `427C0642…7285`, верифікований проти офіційної суми curl.se).
- **Пароль** — локальний `%APPDATA%\postgresql\pgpass.conf` через `PGPASSFILE`; ACL fail-closed
  (SID-базовано: Everyone/Users/AuthUsers = wide → BLOCKED); вміст ніколи не читається.
- **Readers** — два LongRunning таски (stdout/stderr), typed tokens `Pft.ReaderEndToken`
  (`Eof/Killed/Error`), per-run `Pft.RunState` (KillRequested, fault-injection, RunId).
- **Consumer** — неблокуючий симетричний polling обох черг (TryDequeue + 10 ms idle sleep),
  conninfo-парсинг з allowlist-верифікацією, marker-детекція після conninfo, класифікація
  connect/auth/TLS/FATAL до і після readiness.
- **RuntimeDll snapshot** (hook, лише живого процесу): identity re-check (PID reuse guard) → рівно
  один `libpq.dll` → hash TOCTOU → збіг з candidate SHA-256 (`D87674D5…9D04`) → `PQlibVersion=170012`.
- **Readiness marker** — `\echo PFT-READINESS-MARKER` надсилається лише після успішного snapshot.
- **Ordered cleanup** — stdin close → `WaitForExit(5 s)` → typed kill лише після timeout →
  readers Wait → AllTask Wait → Dispose лише після обох readers; ідемпотентний (`Cleanup.Done`).
- **Post-consumer drain** — після verdict і cleanup дренує обидві черги до пуста, залишкові рядки/
  токени → DiagLog; не запускає Consumer повторно, не змінює вердикт.
- **DiagLog** — thread-safe bounded capture (див. розділ E).
- **`PGCONNECT_TIMEOUT=10`** — тільки в environment дочірнього psql.

### Lifecycle diagram

```
Process.Start → Identity check ──fail──▶ kill + exit 2 (BLOCKED)
     │ok
     ▼
Readers (stdout+stderr) start
     ▼
Send-StdinLine '\conninfo' (ровно 1 раз) ──write fail──▶ BLOCKED-stdin-write-failed + cleanup
     ▼
Consumer drain (30 s):
  conninfo line ──allowlist mismatch──▶ BLOCKED (ConninfoMismatch)
     │match → ConnInfoSeen
     ▼
RuntimeDll hook: identity re-check → 1×libpq → TOCTOU hash → candidate match → PQlibVersion
     │any fail──▶ BLOCKED (HOOK-RuntimeDll-*)
     ▼ok
Marker send ('\echo PFT-READINESS-MARKER')
     ▼
Consumer: marker після conninfo → Readiness=CleanReadiness
     │marker до conninfo──▶ BLOCKED (MarkerBeforeConninfo)
     ▼
stdin.Close (ровно раз)
     ▼
Natural exit window (5 s) + ExitCode capture (до Dispose)
     │timeout──▶ BLOCKED (psql-exit-timeout), kill через cleanup
     ▼
Invoke-OrderedCleanup (idempotent) ──CleanupError──▶ BLOCKED-cleanup:<Primary>
     ▼
Invoke-PostConsumerDrain (diagnostic only)
     ▼
Get-RunVerdict (10 predicates) → PASS | BLOCKED:<reason>
     ▼
Write-DiagFlush (sanitized, after verdict)
```

Умови переходів: кожен етап має окрему fail-гілку; PASS недосяжний з будь-якої fail-гілки
(див. розділ D).

---

## D. Fail-Closed Verdict

`Get-RunVerdict` — 10 послідовних predicates (кожен → окремий `BLOCKED:<reason>`); PASS —
єдиний `return` у кінці, досяжний лише при всіх 10 істинних:

1. `ConsumerStatus = CleanReadiness` (агрегує conninfo-allowlist, marker-після-snapshot,
   readiness, відсутність connect/auth/TLS/FATAL до і після readiness).
2. `ConnInfoSeen`.
3. `SnapshotDone` (RuntimeDll evidence).
4. `MarkerSent`.
5. `StdinClosed`.
6. `NaturalExit` (інакше `BLOCKED:psql-exit-timeout`).
7. `ExitCode` доступний і == 0 (інакше `exit-code-unavailable` / `exit-code-N`).
8. Немає stdout/stderr reader Error-токенів.
9. Обидва readers досягли EOF (`streams-not-fully-drained` інакше).
10. `CleanupError` відсутній (інакше `BLOCKED-cleanup:CleanReadiness`, primary збережено окремо).

Недосяжність PASS: `ConsumerTimeout`, `ConnectError`, `ReaderError`, `ReadinessThenStderrError`,
`ReadinessThenReaderError`, `ConninfoMismatch`, `MarkerBeforeConninfo`,
`StdoutEndBeforeReadiness`, `HOOK-*` — всі ≠ `CleanReadiness` → predicate 1 → BLOCKED.
CleanupError, reader-error, відсутність EOF/ConnInfo/snapshot/marker, ненульовий або невідомий
exit code — власні BLOCKED-гілки. Діагностичні класи у verdict не беруть участі (0 посилань).

---

## E. Diagnostic Instrumentation

- **`Pft.DiagLog`** (C#): усі записи під одним `lock`; монотонний `_seq` (timestamp — анотація);
  bounded 2000 записів × 500 символів (обрізання `...<truncated>`); overflow → прапорець `Overflowed`,
  записи відкидаються, накопичення не зростає; write-failure/overflow — лише WARN, вердикт не змінюють.
- **Sanitization** — до збереження і до виводу (`Write-DiagFlush` друкує вже sanitized snapshot):
  `password/passfile/sslpassword` з `=` або `:`, довільні пробіли, довільний регістр;
  `PGPASSWORD=` (регистронезалежно); URI credentials — двопрохідний fail-safe (pass 1: userinfo до
  першого `/`; pass 2: greedy до останнього `@` у токені).
- **Post-consumer drain** — зберігає рядки/токени, що з'явились після виходу Consumer (критично для
  гіпотези stdout-буферизації).
- **Діагностичні класи** (не вердикт): `auth-failure`, `tls-failure`, `connect-timeout`,
  `other-connect-failure`, `stderr-present-unclassified`, `stdout-only(suspect-buffering)`,
  `silent-no-tokens`.
- **Flush** — контрольований, після фінального вердикту, у PASS і BLOCKED гілках, без створення
  файлів і змін ACL.

**Обмеження sanitizer (свідомо зафіксовані):** можливий over-redaction у URI fail-safe (хост/шлях
можуть бути приховані разом з userinfo); значення з пробілами всередині не покриваються (`\S+`);
`\b` не redact'ує keyword усередині довшого слова. **Sanitizer не є універсальним захистом для
довільних логів** — він налаштований на формати psql/libpq виводу цього протоколу.

---

## F. Test Matrix

| Набір | Кількість |
|---|---:|
| T (static self-checks: allowlist, TLS, pgpass ACL) | 14 |
| S (synthetic reader matrix) | 16 |
| R (F1–F6 regression) | 12 |
| N (readiness integrity, verdict gate) | 14 |
| D (diagnostic instrumentation) | 21 |
| I (redaction hardening) | 8 |
| **TOTAL** | **85** |

Результат останнього прогону: **85/85 PASS**, `VALIDATE PASSED`. ID унікальні (85/85, перевірено
regex-сканом); підсумок обчислюється автоматично з фактичних `Assert-Matrix` викликів; усі тести —
synthetic-only (без psql, мережі, БД). **85 синтетичних тестів не доводять працездатність реального
Neon-з'єднання** — вони доводять коректність локальної логіки та fail-closed станів.

---

## G. Security and DB Isolation

- Allowlist: `ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech` / `pft_dbtest` /
  `pft_test_runtime` / `5432` — константи, fallback відсутній; consumer повторно верифікує
  фактичний conninfo.
- TLS: `verify-full`, CA bundle SHA-256 `427C0642…7285`; без `sslmode=prefer|require|disable`,
  без `sslrootcert=system`.
- psql: `C:\Program Files\PostgreSQL\17\bin\psql.exe`, hash-gate preflight; libpq candidate
  SHA-256 `D87674D5…9D04`, `PQlibVersion=170012`.
- `PGPASSWORD` видаляється і ніде не встановлюється; пароль не читається і не друкується;
  pgpass ACL fail-closed (SID-based).
- `-X -w`; `-c`/`-f` відсутні; interactive stdin only; жодних SQL/DDL/DML у Run-блоці.
- `PGCONNECT_TIMEOUT=10` — лише child environment; глобальне середовище не змінюється; не є
  доказом успішного з'єднання.
- Prisma / DB-тести не виконуються; `neondb` і Production виключені (scan Run-блоку — 0
  входжень); allowlist не розширювався.

---

## H. Historical Network Attempts

| Спроба | Результат | Що доведено | Що не доведено |
|---|---|---|---|
| 1 (PHASE 1.42-A контекст) | `BLOCKED-cleanup` | `\conninfo` не надсилався (forensic, SQL=0, системних залишків немає); readiness не відбулось | — |
| 2 (перед PHASE 1.42-F) | `BLOCKED:ConsumerTimeout`, lifetime=30 s | psql запущений, identity OK, stdin write+Flush успішні (структурний висновок з коду), процес завершений, залишків немає | Фактичне виконання `\conninfo`, TLS/auth, RuntimeDll snapshot, readiness; root cause (буферизація vs hang) |

Жодна спроба не є успішним з'єднанням. Друга спроба: `consumerPrimary=` порожній — очікувана
поведінка коду на ConsumerTimeout-шляху, не доказ відсутності stderr.

---

## I. Remaining Risks

1. Реальний формат `\conninfo` (локаль, буферизація) не підтверджений.
2. Поведінка psql stdout buffering у pipe не підтверджена (гіпотеза LIKELY).
3. Реальний TLS/auth handshake не підтверджений.
4. RuntimeDll snapshot у живому psql не підтверджений (probe доказаний на файлі та синтетичному child).
5. `PGCONNECT_TIMEOUT` не гарантує обмеження всіх DNS/мережевих сценаріїв.
6. Sanitizer має зафіксовані обмеження (over-redaction, значення з пробілами, `\b`).

---

## J. Git and Artifacts

Стан на момент консолідації (read-only аудит):
- HEAD: `6561d8b317a74d49c696e028a124d20ad5f638e7` (останній коміт — `feat(ops): instrument crons,
  market worker and email transport`); жодних комітів у фазах 1.42-A–I та в цій фазі.
- Branch: `staging/ai-support-reliability`.
- Modified tracked files: наявні у робочому дереві до початку фаз 1.42 (не створені цими фазами,
  не торкані ними); untracked: `scripts/db-prestage/`, `scripts/observability-db-gate.ts`,
  `docs/audits/PHASE-1.42-CONSOLIDATED-READINESS-REPORT.md` (новий).
- `git diff --check`: чисто (CRLF-попередження — передіснуючий repo-wide шум).
- `prestage.ps1` та `observability-db-gate.ts` — без змін (порожній diff).

---

## K. Final Status

- **Local implementation and synthetic validation: READY / PASS** — 85/85, `VALIDATE PASSED`,
  статично підтверджено (predicates, ID, allowlist, PGCONNECT_TIMEOUT child-only).
- **Real network readiness: UNVERIFIED** — жодна спроба не підтвердила TLS/auth/readiness;
  обидві попередні спроби завершились BLOCKED без встановленого root cause другої.

---

## NEXT ACTION — EXPLICIT OWNER AUTHORIZATION REQUIRED

Наступний дозволений крок — **рівно одна** readiness-only мережева спроба `-Mode Run` з
попередньо визначеним allowlist (`pft_dbtest` / `pft_test_runtime`), TLS `verify-full`,
`PGCONNECT_TIMEOUT=10`, без SQL, з новим DiagLog/post-drain capture. Умова: наявний
`pgpass.conf` з обмеженим ACL (створений власником поза чатом). Цей документ **не є
авторизацією**; `-Mode Run` у межах цієї фази не запускався.
