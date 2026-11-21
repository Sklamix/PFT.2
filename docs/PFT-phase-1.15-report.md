# PHASE 1.15 — Post-Configuration Verification + Database Identity Proof + Final Infrastructure Readiness

Дата: 2026-11-13
Статус: **BLOCKED (виключно owner-configuration)** — увесь автономний дозволений обсяг виконано; три CRITICAL конфігураційні дії власника з PHASE 1.13–1.14 **не виконані** (підтверджено свіжим аудитом), тому фактична ізоляція середовищ і готовність email не можуть бути доведені.
Базис: PHASE 1.14 (PARTIAL), branch `staging/ai-support-reliability`, HEAD `6561d8b` (не змінено), 116 записів у робочому дереві (не змінено).

---

## A. Executive Summary

Мета етапу — наскрізна верифікація після ручного налаштування власником. **Налаштування не застосовано**: свіжий read-only аудит Vercel і `.env.local` показує, що жодна з дій K-1…K-4 не виконана. Відповідно до правил етапу («не підміняти відсутні credentials припущеннями», «не робити висновок про ізоляцію лише за назвами scopes») верифікація виконана там, де можливо без credentials, і чесно зупинена там, де можливі лише припущення.

| # | Перевірка | Статус | Коротко |
|---|---|---|---|
| C | Resend production configuration | **PARTIAL** | Код fail-closed — PASS (24 email-тести); конфігурація — UNCONFIRMED (ключ не оновлювався 23d; контрольне надсилання не дозволене) |
| D | Production/Preview DB isolation | **FAIL → CRITICAL BLOCKER** | `DATABASE_URL` досі один запис Production+Preview; value-level ідентичність недовідома (masked) |
| E | `pft_dbtest` identity | **SKIPPED** | `OBSERVABILITY_TEST_DB_URL` відсутній — identity не довести |
| F | 19 DB-gated tests | **SKIPPED (19/19)** | Не запускався без підтвердження ідентичності (вимога §4) |
| G | Preview URL fail-closed regression | **PASS** | 9/9 тестів |
| H | NOWPayments/Vercel bypass | **PARTIAL** | Bypass НЕ активований (SSO живий: 302); harness 14/14; контрольний live-тест не дозволений |
| I | Full regression | **PASS** | 634 / 553 PASS / 0 FAIL / 81 SKIP (ідентично 1.14); tsc/lint/prisma/build/diff-check — чисто |
| L | Final readiness | **BLOCKED** | Залишкові блокери — лише owner-конфігурація (K-1…K-3) |

Кодова база стабільна й повністю регресована; подальша верифікація заблокована виключно на конфігураційні дії власника.

---

## B. Owner Configuration Verification

Свіжі read-only докази (2026-11-13):

| Дія з 1.14 | Очікуваний слід | Фактичний стан | Висновок |
|---|---|---|---|
| K-1 Resend (домен + non-sandbox ключ + `RESEND_FROM_EMAIL`) | оновлений `RESEND_API_KEY`; верифікований домен | `RESEND_API_KEY` Production+Preview, запис **23d ago** (не оновлювався); живий 422-sandbox доказ з 1.12 залишаЇться актуальним | **НЕ ВИКОНАНО** |
| K-2 Розділити `DATABASE_URL` | окремі записи для production і preview | **один запис: `Production, Preview`** (3d ago; змін не видно) | **НЕ ВИКОНАНО** |
| K-3 `pft_dbtest` credentials | `OBSERVABILITY_TEST_DB_URL` локально/Vercel | відсутній і локально, і в Vercel | **НЕ ВИКОНАНО** |
| K-4 NOWPayments preview (bypass + IPN secret) | `NOWPAYMENTS_IPN_SECRET` у preview scope; bypass secret | `NOWPAYMENTS_IPN_SECRET`/`NOWPAYMENTS_IPN_KEY` у preview scope — **absent** (env pull) | **НЕ ВИКОНАНО** |
| K-5 `NEXT_PUBLIC_APP_URL` у preview | запис у preview scope | **absent** у preview env pull | **НЕ ВИКОНАНО** (покривається fail-closed fallback-ом `appUrl()`) |

Локально: `RESEND_FROM_EMAIL` досі порожній; `OBSERVABILITY_TEST_DB_URL`/`PAYOUT_CONCURRENCY_TEST_DB_URL` відсутні; `NEXT_PUBLIC_APP_URL` = `"http://localhost:3000"` (безпечна dev-конфігурація).

---

## C. Resend Verification — PARTIAL

**Код (PASS, доказ — 24 тести в повному прогоні):**
- `lib/email/resend.ts` без змін з 1.13: `isProductionRuntime`/`resolveSender`/`classifyResendFailure` на місці; production без/з порожнім `RESEND_FROM_EMAIL` → FAILED без HTTP-виклику (тести email-sender-policy 1–3; email-transport 3b); жодного шляху до `onboarding@resend.dev` у production (fallback лише dev/тести — тести 4,5); класифікація 422 (sandbox/домен), 401/403 (API key); без витоку отримувача/тіла (тест 6); усі 24 call-sites через єдиний `sendEmail` (тест 11).

**Конфігурація (UNCONFIRMED):**
- `RESEND_API_KEY`: єдиний запис Production+Preview, created 23d — збігається зі станом 1.12, коли живий probe довів sandbox-обмеження (422). Non-sandbox ключ не встановлено.
- `RESEND_FROM_EMAIL`: три записи (Production/Preview/Development), значення — quoted masked placeholder (`"[SENSITIVE]"`, fingerprint: quote-wrap, `[`, без `@`, без `://`) — sender-домен і відповідність домену верифікувати неможливо.
- Контрольне надсилання: **не проводилося** — тестова адреса не надана, дозвіл не отриманий (правила етапу). Фактична поведінка «422 більше не виникає» — НЕ ПІДТВЕРДЖЕНА.

## D. Production/Preview Database Isolation — FAIL (CRITICAL BLOCKER)

Фактичні scopes (свіжий `vercel env ls`, names/scopes only):

| Variable | Production | Preview | Development |
|---|---|---|---|
| `DATABASE_URL` | **та сама одна записка** | **та сама одна записка** | відсутня (локальний `.env.local` → інший target, але value недоступний для порівняння) |
| `DIRECT_URL` | відсутня | відсутня | відсутня |
| Workers/cron | спільні scope-набори; окремих DB-credentials немає | | |

Спроба value-level верифікації: `vercel env pull --environment preview` повертає для `DATABASE_URL` **quoted masked placeholder** (fingerprint: len 13, first/last char `"` ( `"…"` ), містить `[`, не містить `@` і `://` — тобто `"[SENSITIVE]"`, а не connection string). Реальне значення недоступне безпечним шляхом.

Ідентичність (`current_database()`, `current_user`, `current_schema()`, server identity): **не виконана** — підключення до Production заборонене, до Preview — неможливе без credentials. Environment-specific marker відсутній у коді (не створювався — це була б зміна рантайму).

**Обов'язковий висновок:** довести «Preview не використовує Production DB» неможливо; єдиний запис на обидва скопи логічно еквівалентний спільному значенню. Висновок лише за назвами scopes заборонений правилами етапу. → **CRITICAL BLOCKER** (залишається з 1.12). Небезпечних fallback між середовищами в коді немає (Prisma-клієнт єдиний; тестовий гейт fail-closed — тести зелені).

## E. Test DB Identity — SKIPPED

`OBSERVABILITY_TEST_DB_URL` відсутній (локально та в Vercel). `neondb` не використовувався, credentials не вгадувалися/не перебиралися, connection strings не виводилися. Identity-check неможливий → за правилом §4 тести НЕ запускатися. Гейт (`test-db-guard` + `observability-db-gate`) — fail-closed, власні тести зелені: exact host-allowlist, обов'язковий db `pft_dbtest`, `sslmode=verify-full`, жива перевірка `current_database()` перед першим записом, production-хост жорстко заборонений.

## F. 19 DB-Gated Tests — SKIPPED (19/19)

Не запускався: identity не підтверджена (E). Причини (без змін): 10× `requires OBSERVABILITY_TEST_DB=1 and OBSERVABILITY_TEST_DB_URL for the isolated pft_dbtest database`; 9× `requires PAYOUT_CONCURRENCY_TEST_DB=1 and PAYOUT_CONCURRENCY_TEST_DB_URL (isolated pft_dbtest)`. Це чесні SKIP, не масковані PASS; очікування після K-3 — 19/19 PASS.

## G. Preview URL Regression — PASS

`scripts/app-url.test.ts` — **9/9 PASS** у повному прогоні: explicit var найвищий пріоритет; preview → `https://$VERCEL_URL`; **preview без обох значень → контрольована помилка** (включно з empty-string `VERCEL_URL`); production не отримує preview URL (ігнорує `VERCEL_URL` навіть при VERCEL_ENV=production); development → `http://localhost:3000` (включно з `VERCEL_ENV=development`); scheme-less → throw з `cause`; лапки нормалізуються без небезпечних ефектів (quote-only → fallback). Споживачі (credentials email, password reset, breach-notice, checkout, certificate `verifyUrl`) — через спільний `appUrl()` (wiring-тест).

## H. NOWPayments / Vercel Protection Security — PARTIAL

**Bypass audit (обов'язковий перед будь-якою активацією):**
- Scope за документацією Vercel: Protection Bypass for Automation діє «for all deployments in a project» і передається header-ом або query-параметром `?x-vercel-protection-bypass=` (документовано саме для вебхук-провайдерів без кастомних заголовків).
- Розмежування середовищ: у PFT діє Standard Protection (preview/deployment URLs захищені, production-домени публічні) — тому bypass secret на практиці відкриває лише protected preview/deployment URLs; Production protection не послаблюється. Секрет потрапляє в конфігурацію NOWPayments callback URL — трактувати як конфіденційний, ротація: disable/enable у Vercel Settings (генерується новий секрет) + оновлення NOWPayments. Логи/моніторинг/звіт: секрет не друкувався і не записувався.
- **Рішення: bypass НЕ активований** — власник не налаштував і не дозволив. Живого webhook-тесту не проводилося. Альтернатива зафіксована: окремий webhook-only Vercel-проєкт (protection off на ньому, HMAC обов'язковий, preview `DATABASE_URL`) або залишатися на локальному harness.

**Фактичні докази захисту (живі probe-и, read-only):**
- Preview deployment URL, unauthenticated GET `/login` → **302** (редирект на SSO) — Vercel Authentication підтверджено активним, bypass не діє.
- Production домен `pft-app-prod.vercel.app`, GET `/login` → **200** — очікувана асиметрія Standard Protection.

**Локальний harness (PASS):** `scripts/webhook-ipn.test.ts` — 14/14 PASS (валідний PAID → умовне оновлення; forged signature → 401; відсутній secret → 503; duplicate → `{duplicate:true}`; некоректний payload → 400; пізній FAILED після PAID → без апдейтів; `NOWPAYMENTS_IPN_KEY` fallback вимагає валідного підпису). Preview `NOWPAYMENTS_IPN_SECRET` — досі absent → навіть з bypass ендпоінт відповідав би 503 fail-closed. Production secret у Preview не копіювався; Production webhook configuration не змінювалася.

## I. Full Regression — PASS

| Перевірка | Результат |
|---|---|
| Повний прогін | **634 / 553 PASS / 0 FAIL / 81 SKIP**, exit 0 |
| Бейзлайн 1.14 | 634 / 553 / 0 / 81 — **дельта 0** (кодових змін етапу немає; пояснення не потрібне) |
| `npm run test:db:gated` | 19/19 SKIPPED (F) |
| TypeScript | exit 0 |
| ESLint | 0 errors, 63 warnings (pre-existing), exit 0 |
| `npx prisma validate` | valid |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 (лише pre-existing CRLF-попередження) |

## J. Security and Data Integrity

- Production env/database/schema: не змінювалися; `prisma db push`/міграції/destructive SQL не виконувалися.
- Реальні платежі/виплати/webhook-транзакції: не запускався; жодного листа не відправлено.
- Vercel звернення: лише read-only (`env ls`, `env pull --environment preview`, `ls` deployment-список); env-pull файли видалялися одразу; значення не друкувалися (лише структурні fingerprint-и: довжина, лапки, наявність `[`/`@`/`://`).
- Live probe-и: unauthenticated GET (без bypass secret, без credentials) — не змінюють стан.
- Git: HEAD `6561d8b` не змінено; stage/commit/push/merge/reset/clean не виконувалися; усі 116 записів робочого дерева збережено.
- Секрети: не надруковані, не записані в звіт, не закомічені.

## K. Remaining Blockers

| # | Блокер | Статус | Що саме потрібно від власника |
|---|---|---|---|
| 1 | Resend non-sandbox конфігурація | CRITICAL | Верифікувати домен (DNS SPF/DKIM) → non-sandbox Full Access key → замінити `RESEND_API_KEY` (production, окремий для preview) → `RESEND_FROM_EMAIL` = `PFT Challenges <noreply@<домен>>` (production). Після цього: надати авторизовану тестову адресу + дозвіл на один контрольний лист |
| 2 | `DATABASE_URL` спільний Production+Preview | CRITICAL | Окремі записи для production і preview скопів (окрема preview-БД/Neon branch); після застосування — value-level proof через `env pull` (порівняння хост/ім'я БД, masked) або контрольний read-only `current_database()` |
| 3 | `pft_dbtest` credentials | CRITICAL | `OBSERVABILITY_TEST_DB_URL` (+`PAYOUT_CONCURRENCY_TEST_DB_URL`) на схваленому тестовому endpoint з db `pft_dbtest`; тоді 19/19 тестів виконаються |
| 4 | Preview webhook доступ | HIGH | Bypass for Automation + preview `NOWPAYMENTS_IPN_SECRET` + дозвіл на контрольний підписаний webhook (recipe 1.14 K-4); альтернатива — окремий webhook-only проєкт |
| 5 | `NEXT_PUBLIC_APP_URL` preview | OPTIONAL | Явне значення; код уже покритий fail-closed fallback-ом |

## L. Final Readiness Decision

**BLOCKED — infrastructure readiness не може бути підтверджена.**

Критерії PASS: (1) Resend config — не виконаний; (2) DB isolation — не доведена (CRITICAL BLOCKER); (3) `pft_dbtest` identity — не доведена; (4) 19/19 — не виконані (не могли бути запущені без (3)); (5) Preview URL fail-closed — **PASS**; (6) NOWPayments — harness PASS, безпечний live доступ не активований; (7) повна регресія — **PASS** (0 FAIL); (8) Production data/config — **без змін** (PASS).

Жоден критерій не підтверджено припущенням. Усі CRITICAL-пункти (1–4) залежать від одних і тих самих owner-конфігураційних дій K-1…K-3 (див. 1.14 K-розділ — покрокові інструкції без змін). Автономний обсяг етапу вичерпано: наступна дія — за власником. Після її виконання PHASE 1.16 може виконати value-level верифікацію (DB identity, контрольний email, 19/19 тестів, живий webhook) і закрити готовність як PASS.
