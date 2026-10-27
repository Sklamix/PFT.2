# PFT.2 — технічний backlog після стрес-тесту v1.4

**Статус:** P0 і P1 закрито; запуск блокується лише legal review і operator-задачами.  
**Джерело:** `docs/PFT-rulebook-v1.md` v1.6.  
**Код:** локальний commit P0-3 leftovers; QA — 93/93 на локальному production build. Handoff: `docs/PFT-production-rollout.md`.  
**Мета:** закрити P0-лазівки до публічного запуску, потім P1/P2.

---

## Launch checklist

- [x] P0-1. Payout eligibility gate — gate + payout holds + risk-review hold
- [x] P0-2. Payout-adjusted drawdown — virtual equity + fixed-dollar trailing
- [x] P0-3. Automatic passing + KYC gate — second-admin approval for every status override
- [x] P0-4. Static drawdown — реалізовано; потрібно застосувати SQL-міграцію
- [x] P0-5. News window — технічний доступ, warning, annulment, second closure, payout hold
- [x] P0-6. Overnight/weekend auto-close — close-only + per-symbol auto-close + pending cancel
- [x] P0-7. Account limits + related accounts — phone + IP/device aggregation, checkout, provisioning, standby, reconciliation, admin UI
- [x] P0-8. Copy / cross-account net exposure — deterministic breach matrix + automated cron enforcement
- [x] P0-9. Reset cap + frozen rules — eligibility, 30-day cap, paid checkout, webhook provisioning
- [x] P0-10. Payout hold + trade void + abnormal-profit flag + admin UI
- [x] P1-1. Daily loss CE(S)T
- [x] P1-2. Fixed-dollar trailing (у складі P0-2)
- [x] P1-3. Target freeze
- [x] P1-4. Consistency by open date
- [x] P1-5. News per-account + user-level risk flag
- [x] P1-6. IP/VPN/session controls
- [x] P1-7. Rule changes and versioning
- [x] P1-8. Breach matrix + appeals
- [x] P1-9. Negative balance protection
- [x] P1-10. Public copy alignment
- [x] P1-11. Inactivity job
- [x] P1-12. Frozen backup policy
- [x] Public copy alignment — 80%, weekly payouts, no refund, news windows, terminal naming
- [x] Regression + build (`npx tsc --noEmit`, `npm run build`)
- [x] Production migrations — 6 SQL files застосовано через guarded deploy 27.10.2026
- [ ] Production migrations P1 — `account-appeals.sql`, `risk-flags-and-backups.sql`, `session-risk.sql`, `rules-versioning.sql`
- [x] Manual QA — 93/93 на локальному production build (`npm run qa:smoke`)
- [x] Readiness self-check — `npm run doctor` (env, schema columns, cron freshness)
- [x] Cloudflare cron — schedule `* * * * *`, secrets присутні, живий цикл підтверджено `wrangler tail`
- [x] Backup / rollback plan — `docs/PFT-operations-runbook.md`, `npm run db:backup` перевірено
- [ ] Neon PITR retention підтвердити в консолі Neon
- [ ] Legal review of final rulebook — очікує counsel, brief у `docs/PFT-launch-qa.md` §4
- [ ] Legal pages published — Terms, Privacy, Risk, AML, Refund (після counsel)

### Step 1 — реалізовано

**P0-1 (core):**

- `lib/payouts/eligibility.ts` — серверний payout gate.
- `app/api/payouts/route.ts` — перевірка перед резервуванням payout.
- Перевіряються: KYC, 7 днів, відсутність позицій/pending-ордерів, один pending payout, 3 profitable days, consistency 20%, min $25/1%.
- Додано пізніше: payout holds (`PayoutHold`) і `RISK_REVIEW_HOLD` для compliance/news review.

**P0-2:**

- `lib/trading/repository.ts` — `withdrawnProfit` з payout-записів.
- `lib/trading/risk.ts` — `riskEquity = equity + withdrawnProfit`; fixed-dollar trailing.
- Payout більше не зменшує `peakEquity`; reject не повертає його штучно.
- `AccountView`/terminal snapshot отримали `withdrawnProfit`.

### Step 2 — реалізовано

**P0-3 (core):**

- `lib/trading/passing.ts` — серверний pass evaluator:
  - closed P&L target;
  - minimum distinct trading days;
  - no open positions;
  - Phase 1 → Phase 2 reset;
  - final pass → `PASSED` / `PASSED_PHASE_2`, phase `FUNDED`.
- `app/api/cron/trading/route.ts` — прогін passing для активних evaluation-акаунтів.
- `app/api/trading/order/route.ts` і `pending/route.ts` — target lock (нові позиції блокуються, коли target + min days виконані).
- `app/api/admin/accounts/[id]/override/route.ts` — заборона FUNDED без KYC/approved/passed стану.
- `lib/admin/repository.ts` — FUNDED override скидає funded-акаунт до initial balance і ставить phase FUNDED.
- `lib/trading/engine.ts` — FUNDED-акаунти тепер можуть торгувати й проходять risk engine.
- `app/api/cron/trading/route.ts` — funded-акаунти також синхронізуються.

**P0-3 leftovers — закрито:**

- second-admin approval для FUNDED override закрито раніше в Step 15/18 (тепер для всіх status);
- автоматичне funding після KYC approval: `lib/trading/funding.ts` + `setKycStatus` (audit `ACCOUNT_AUTO_FUNDED`, `actorId = null`, idempotent за статусом `PASSED`/`PASSED_PHASE_2`); balance скидається до `initialBalance`, stale pending-ордери скасовуються;
- скасування вже існуючих pending-ордерів у момент target lock: `lib/trading/target-lock.ts` + `BookTx.targetLocked` у `lib/trading/engine.ts` (cancel + audit `PENDING_ORDERS_CANCELLED`) і додатково в `lib/trading/passing.ts` на переході phase/funding.

### Step 3 — реалізовано

**P0-4 — static drawdown:**

- `prisma/schema.prisma` — додано `TradingAccount.drawdownMode`.
- `prisma/sql/static-drawdown.sql` — ідемпотентна SQL-міграція.
- `lib/provisioning/challenge-account.ts` — checkout mode зберігається в акаунті.
- `lib/trading/risk.ts` — static floor = initial balance − 6%/10%; trailing = high-water mark − fixed dollar buffer.
- `lib/trading/engine.ts`, `lib/trading/types.ts`, `lib/stores/useTerminalBook.ts` — режим передається в термінал.
- Оновлено UI-копію drawdown (прибрано старе “locks at starting balance”).
- Перевірено: static floor $9,400, trailing floor $9,900 для $10k/6%.

**Перед production:** застосувати `prisma/sql/static-drawdown.sql`; без неї новий код не знайде колонку.

### Step 4 — реалізовано

**P0-5 (оновлена модель доступу):**

- `lib/market/news-windows.ts`:
  - upcoming high-impact window +5 хв;
  - idempotent warning email per account/event.
- `lib/email/news-warning.ts` — лист із display ID акаунта, назвою та часом події.
- `app/api/cron/trading/route.ts` — warning emails щохвилини.
- **Технічного блокування ордерів у news-вікні немає** — за рішенням власника трейдер може відкрити позицію, але це порушення правил.
- Pending-ордери більше не скасовуються автоматично.

### Step 5 — реалізовано

**P0-5b — violation enforcement:**

- `lib/trading/repository.ts`:
  - визначає high-impact event навколо `position.openedAt`;
  - in-window (±5 хв) — violation;
  - 5–60 хв до події + позиція пережила подію — violation;
  - ≥60 хв до події — warning only;
  - audit log `NEWS_WINDOW_EXPOSURE`.
- `lib/trading/engine.ts`:
  - анулює лише прибуток конкретної violating-угоди;
  - збиток не компенсується;
  - перше порушення — warning email + annulment;
  - друге порушення — closure лише цього Funded-акаунта, решта позицій ліквідується.
- `lib/email/trade-events.ts` — email із display ID, event title, annulled P&L, violation number.
- `lib/payouts/eligibility.ts` — payout hold на 7 днів після news-порушення.

**Що ще не зроблено в P0-5:**

- medium-impact warnings;
- calendar-outage fallback close-only;
- групування кількох violating-угод однієї події як одного порушення (зараз кожна угода — окремий violation).

### Step 6 — реалізовано

**P0-6 — overnight/weekend auto-close:**

- `lib/trading/session-cutoff.ts`:
  - daily cutoff для FX/metals/crypto: 22:00 London у UTC (summer 21:00 UTC, winter 22:00 UTC);
  - Friday fallback 21:00 UTC;
  - weekend close-only;
  - 15-хв close-only вікно.
- `lib/market/index-sessions.ts`:
  - `indexSessionEnd()` та `isIndexCloseOnly()`.
- `lib/trading/overnight.ts`:
  - auto-close лише тих символів, які дійшли cutoff;
  - скасування pending-ордерів у close-only.
- `lib/trading/engine.ts`:
  - `closePositionsBySymbols()` — не закриває зайві інструменти.
- `app/api/trading/order/route.ts` і `pending/route.ts` — close-only блокує нові ордери.
- `app/api/cron/trading/route.ts` — auto-close + pending cancel + email notifications.

**Що ще не зроблено в P0-6:**

- окремий календар свят/ранніх закриттів;
- окремий crypto-графік (зараз fallback daily/Friday);
- first/second violation для випадків, коли auto-close не встиг закрити позицію (наприклад, feed outage).

### Step 7 — реалізовано

**P0-7 — account limits + related accounts:**

- `lib/accounts/limits.ts`:
  - max **3 active accounts**;
  - max **$200,000 aggregate allocation**;
  - count active/funded/passed accounts;
  - exclude frozen backup until activation;
  - aggregate users with the same normalized phone.
- `app/api/checkout/route.ts` — block checkout before payment.
- `lib/provisioning/challenge-account.ts` — guard before account creation.
- `app/api/webhooks/payment-success/route.ts` — paid order blocked by limit is marked `provisioningBlocked`, no partial provisioning.
- `lib/trading/repository.ts` — frozen backup activation also checks 3/$200k and writes `STANDBY_ACTIVATION_BLOCKED`.

**Додано після завершення Step 7:**

- `User.lastLoginIp`, `User.lastDeviceHash` + SQL `account-fingerprints.sql`;
- запис fingerprint при password login, email-code login, Google login, set-password;
- related accounts агрегуються за phone **або** IP + device hash;
- hourly reconciliation `ACCOUNT_LIMIT_RECONCILIATION`;
- admin Orders UI показує `provisioningBlocked`.

**Обмеження:**

- payment method / copy-trading relationship ще не агрегуються;
- IP + device hash може давати false positives у сімейному/спільному середовищі — це привід для review, а не автоматичного закриття.

### Step 8 — реалізовано (core)

**P0-8 — cross-account net exposure:**

- `lib/trading/net-exposure.ts`:
  - групує акаунти одного risk group;
  - рахує long/short lots по кожному символу;
  - флагує протилежні позиції **на різних акаунтах**;
  - same-account hedging не флагується;
  - пише audit `CROSS_ACCOUNT_HEDGE` на кожен задіяний акаунт.
- `app/api/cron/trading/route.ts` — скан раз на 10 хвилин, audit `CROSS_ACCOUNT_HEDGE_RUN`.

**Що ще не зроблено в P0-8:**

- автоматичне закриття/анулювання прибутку за cross-account hedging;
- email/Telegram alert для risk team;
- повна інтеграція copy-trading relationship.

### Step 9 — реалізовано (core)

**P0-9 — reset cap + frozen rules:**

- `prisma/schema.prisma` + `prisma/sql/account-resets.sql`:
  - `TradingAccount.resetSourceAccountId`.
- `lib/accounts/reset.ts`:
  - reset only after breach;
  - frozen backup blocked;
  - no reset for abuse/fraud/second news violation;
  - max **1 reset per product / 30 days**;
  - 20% discount within 2 days, full price after;
  - creates a new fresh Phase 1 account;
  - new account linked to the breached account.
- `app/api/admin/accounts/[id]/reset/route.ts`:
  - `GET` eligibility/price;
  - `POST` admin-granted reset with `confirm: true`.

**Що ще не зроблено в P0-9:**

- окремий paid checkout для reset;
- trader-facing reset UI;
- automatic reset purchase/payment webhook.

### Step 10 — реалізовано (core)

**P0-10 — payout hold:**

- `lib/payouts/holds.ts`:
  - `PAYOUT_HOLD` / `PAYOUT_HOLD_CLEARED` audit flow;
  - active hold detection.
- `lib/payouts/eligibility.ts`:
  - manual `PAYOUT_REVIEW_HOLD`;
  - news hold 7 днів;
  - payout gate блокує запит.
- `app/api/admin/accounts/[id]/payout-hold/route.ts`:
  - `GET` active hold;
  - `POST` hold/clear with reason.
- Manifest error/off-market: адмін може поставити hold і вручну провести review.

**Що ще не зроблено в P0-10:**

- автоматичне void конкретної TradeHistory-угоди з коригуванням балансу;
- автоматичний abnormal-profit detector;
- admin UI для hold/clear;
- повний audit trail для void/refund.

### Step 11 — реалізовано

**P1-1 — daily loss CE(S)T:**

- `lib/trading/time.ts` — `startOfBerlinDay()`.
- `TradingAccount.dailyStartingBalance` + `dailyStartedAt`.
- `lib/trading/engine.ts` — daily start higher-of balance/equity, once per CE(S)T day.
- `lib/trading/repository.ts` — зберігає `dailyStartingBalance`, `dailyStartingEquity`, `dailyStartedAt`.
- `lib/provisioning/challenge-account.ts` — нові акаунти стартують з коректним daily snapshot.
- payout request/reject/approve коригують `dailyStartingBalance`.
- SQL `prisma/sql/daily-loss-cet.sql` застосовано.

### Step 12 — реалізовано

**P0-10 full:**

- `prisma/schema.prisma` + `prisma/sql/trade-voids.sql`:
  - `TradeHistory.originalPnl`, `voidedAt`, `voidReason`.
- `app/api/admin/trades/[id]/void/route.ts`:
  - void конкретної угоди;
  - повертає її P&L з балансу/equity;
  - коригує peak equity;
  - audit `TRADE_VOIDED`.
- `app/api/admin/accounts/[id]/payout-hold/route.ts`:
  - hold/clear payout;
  - admin UI у trade ledger.
- `app/api/payouts/route.ts`:
  - audit `PAYOUT_ABNORMAL_PROFIT` при payout ≥ $10k або profit ≥ 50% стартового балансу.
- `components/admin/trade-history-modal.tsx`:
  - кнопки Hold/clear payout;
  - кнопка Void для CLOSED угод;
  - показ `VOIDED` + reason.

**Що ще не зроблено:**

- автоматичне виявлення manifest-error без участі адміна;
- автоматичний void без review;
- screenshots/audit bundle для void.

### Step 13 — реалізовано

**P1-10 — public copy alignment:**

- 80/20 profit split замість 90/10;
- payout: first after 7 days, then once every 7 days, no on-demand;
- fee non-refundable;
- reset: 20% within 2 days, new Phase 1, frozen blocked, 30-day cap;
- news: eval unrestricted, funded ±5 min, 5–60 min exposure, 60+ warning;
- consistency 20%;
- daily reset 00:00 CE(S)T;
- прибрано MT4/MT5/cTrader/DXtrade — публічно PFT Web Terminal;
- max allocation $200K замість $400K;
- normalized payout review 1–3 business days;
- payout-card/badge “Bi-weekly” → “Weekly”.

### Step 14 — реалізовано

**P1-11 — inactivity:**

- `lib/email/inactivity.ts` — warning + closure emails.
- `lib/accounts/inactivity.ts`:
  - 60-day warning;
  - 90-day closure;
  - warning audit idempotency;
  - 7-day grace if warning was missed;
  - liquidation of open positions before closure.
- `app/api/cron/trading/route.ts` — hourly inactivity scan + audit `INACTIVITY_SCAN_RUN`.

### Step 15 — реалізовано

**Final P0 leftovers:**

- **Second-admin funding approval**
  - `lib/admin/funding-approval.ts`;
  - `FUNDED_APPROVAL_REQUESTED` / `FUNDED_APPROVAL_APPROVED`;
  - request TTL 24h;
  - self-approval blocked;
  - `POST /api/admin/accounts/[id]/fund-approval` — request or approve with `requestId`;
  - `override` to FUNDED тепер створює approval request, а не фандить одразу.
- **Single active trader session**
  - `User.activeSessionId`;
  - SQL `prisma/sql/active-session.sql` застосовано;
  - новий login invalidates previous cookie;
  - `getTraderSession` перевіряє session id;
  - password, email-code, Google and set-password flows use `issueTraderSession`.

**Що залишилось на той момент (закрито в Step 16/18):**

- admin UI для другого адміна, щоб бачити pending funding requests;
- logout може явно очищати `activeSessionId` (зараз cookie просто видаляється).

### Step 16 — реалізовано

**Закриття P0-залишків + launch QA:**

- **Funding approvals UI**
  - `GET /api/admin/funding-approvals`;
  - `components/admin/funding-approvals.tsx`;
  - approve / reject другим адміном;
  - self-request і expired запити заблоковані;
  - dedupe pending-запитів;
  - reject audit `FUNDED_APPROVAL_REJECTED`.
- **Session teardown**
  - `endTraderSession()` очищає `activeSessionId` лише якщо cookie все ще володіє сесією;
  - `/api/auth/logout` викликає teardown перед очищенням cookie.
- **Launch QA**
  - `docs/PFT-launch-qa.md` — матриця перевірок, production-міграції, manual QA, legal brief, go/no-go.

### Step 17 — реалізовано

**Production release + QA:**

- `scripts/migrate-stress-test.cjs` — guarded застосунок лише 6 stress-test SQL;
- `package.json` — `prebuild` запускає guarded migration; `qa:smoke`;
- `scripts/qa-smoke.cjs` — 23 HTTP/DB перевірки;
- production deployment `dpl_7gstvsBwbYbFipxCF4aQepteTajH` (27.10.2026):
  - усі 6 міграцій застосовано;
  - `PFT_STRESS_MIGRATIONS` видалено після build;
  - `/`, `/login`, `/admin/login`, `/api/stats` перевірено.
- **QA-фікс:** logout більше не залишає старий cookie валідним; `getTraderSession` вимагає точний `activeSessionId`.

**Legal pages:** навмисно не опубліковані — очікують counsel.

### Step 18 — реалізовано

**Second-admin approval для кожного admin override (не лише FUNDED):**

- `lib/admin/override-approval.ts` — єдина generic-реалізація:
  - `requestAccountOverride` / `approveAccountOverride` / `rejectAccountOverride` / `listPendingAccountOverrides`;
  - reason обов'язковий на рівні API;
  - TTL 24 год, self-approval заблокований;
  - один pending запит на акаунт; інший target status → `409 Reject it first`;
  - повторний запит на той самий status повертає наявний `requestId` (`reused: true`).
- `POST /api/admin/accounts/[id]/override` — завжди створює approval request (`202`).
- `POST /api/admin/accounts/[id]/override-approval` — canonical approve/reject/request endpoint.
- `POST /api/admin/accounts/[id]/fund-approval` — backward-compatible alias.
- `GET /api/admin/funding-approvals` — тепер віддає всі pending overrides із `status`.
- `components/admin/override-approvals.tsx` — черга з target status; причина в діалозі більше не підставляється автоматично, кнопка неактивна без reason.
- Audit: `ACCOUNT_OVERRIDE_REQUESTED`, `ACCOUNT_OVERRIDE_APPROVED`, `ACCOUNT_OVERRIDE_REJECTED`; legacy `FUNDED_APPROVAL_*` читається для старих рядків.
- `lib/admin/funding-approval.ts` і `components/admin/funding-approvals.tsx` видалені після міграції.
- QA розширено до 31/31: non-FUNDED override (`PASSED_PHASE_1`) не змінює статус до другого підтвердження, self-approval блокується, конфліктний pending status → 409, reason обов'язковий.
- Production deployment `dpl_A7pyV5EMN8nXjcFmfSFsNw57w1ns` (27.10.2026): `/`, `/login`, `/admin/login` → 200; `/api/stats` → `source=database`; admin endpoints без сесії → 401.

### Step 19 — реалізовано

**Post-action review для breach kill-switch і reset:**

- `lib/admin/action-review.ts`:
  - `recordActionReviewRequest` / `decideActionReview` / `listPendingActionReviews`;
  - review SLA 24 год, overdue показується в UI, але review не блокується;
  - acting admin не може review-ити власну дію;
  - decision — `confirm` або `flag`, note обов'язковий.
- `lib/admin/repository.ts` — breach пише `ACCOUNT_ACTION_REVIEW_REQUESTED` в одній транзакції з `ACCOUNT_BREACH`.
- `lib/accounts/reset.ts` — reset пише review request у тій самій транзакції, що й `ACCOUNT_RESET`.
- `GET /api/admin/action-reviews` — черга post-action reviews.
- `POST /api/admin/accounts/[id]/action-review` — confirm/flag другим адміном.
- `components/admin/action-reviews.tsx` — черга в admin desk.
- Audit: `ACCOUNT_ACTION_REVIEW_REQUESTED`, `ACCOUNT_ACTION_REVIEW_CONFIRMED`, `ACCOUNT_ACTION_REVIEW_FLAGGED`.
- QA розширено до 42/42: breach і reset виконуються одразу, створюють review, self-review → 403, note обов'язковий, другий адмін confirm/flag, запис зникає з черги.

**Операційна перевірка:**

- Cloudflare worker `pft-market-worker`: schedule `* * * * *`, secrets `CRON_SECRET` / `DATABASE_URL` / `PFT_APP_URL`; `wrangler tail` підтвердив `trading cron processed`.
- `scripts/db-backup.cjs` + `npm run db:backup` — логічний export усіх 21 Prisma-моделей з manifest і SHA-256; перевірено локально (14 022 рядки).
- `docs/PFT-operations-runbook.md` — cron, backup, restore drill, rollback matrix, release checklist.
- Production deployment `dpl_VpnbredSMQnoZ9iDzCPnFdHfFyLW` (27.10.2026): `/`, `/login`, `/admin/login` → 200; `/api/admin/action-reviews` і `/api/admin/funding-approvals` без сесії → 401; `/api/stats` → `source=database`; cron `/api/cron/trading` → 200 на цьому ж deployment.
- RISK_MANAGER більше не тягне admin-only черги в admin desk, тому desk не падає з 403.

**Legal pages:** навмисно не опубліковані — очікують counsel.

---

## 0. Рішення щодо виключень

Не впроваджувати:

- **F13** — minimum trading days залишається “день, у якому відкрито хоча б одну позицію”.
- **F19** — 3 profitable days залишаються з порогом ≥0.5%, без мінімального обсягу.
- **F20** — не додавати KYC device/payment match, video verification та identity-device comparison.
- **F29** — не додавати wallet ownership verification / allowlist для crypto.

Існуючий KYC-гейт “після passing, до Funded credentials” зберігається.

---

## P0 — до публічного запуску

### P0-1. Payout eligibility gate

**Правила:** 17.2–17.4, 21.  
**Файли:** `app/api/payouts/route.ts`, новий `lib/payouts/eligibility.ts`, можливо `lib/payouts/constants.ts`.

**Перевірки на сервері:**

1. Акаунт належить трейдеру і має статус `FUNDED`.
2. `user.kycStatus === 'APPROVED'`.
3. Минуло ≥7 календарних днів від першої виконаної угоди на Funded.
4. Немає відкритих `Position`.
5. Немає `PendingTradeOrder` зі статусом `PENDING`.
6. Немає іншого `Payout` зі статусом `PENDING`/`APPROVED`.
7. Немає активного news/compliance flag.
8. Є ≥3 profitable days у поточному циклі; кожен ≥0.5% від початкового балансу.
9. Consistency ≤20%.
10. Сума ≥ `max($25, 1% of currentBalance)`.
11. Сума ≤ available profit share.
12. Закрити прямий API-обхід: перевірки не можна обійти через UI.

**Acceptance criteria:**

- прямий POST з невалідним KYC/строком/сумою повертає 400/403;
- повторний pending payout блокується;
- payout з відкритою позицією блокується;
- є unit-тести на кожну умову;
- існуючі успішні payout-сценарії не ламаються.

---

### P0-2. Payout-adjusted drawdown

**Правила:** 6.1, 17.4.  
**Файли:** `prisma/schema.prisma`, `lib/trading/risk.ts`, `lib/trading/engine.ts`, `app/api/payouts/route.ts`, `lib/admin/repository.ts`.

**Завдання:**

- Додати облік `withdrawnProfit` (або еквівалент) на `TradingAccount`.
- Drawdown рахувати на `virtualEquity = currentEquity + withdrawnProfit`.
- Payout не зменшує `peakEquity`; він не створює новий risk budget.
- Payout не може опустити floor нижче рівня до запиту.
- Узгодити daily loss: payout не повинен штучно створювати breach.
- Виправити reject/approve flow, щоб не було подвійного відновлення balance/peak.

**Acceptance criteria:**

- після payout floor не знижується;
- після payout акаунт не стає “свіжим” для ризику;
- повторні payout не накопичують прихований risk budget;
- тести на approve/reject/повторний request.

---

### P0-3. Automatic passing + KYC gate

**Правила:** 4, 7, 21.  
**Файли:** `lib/trading/engine.ts`, `app/api/cron/trading/route.ts`, `app/api/admin/accounts/[id]/override/route.ts`, `lib/admin/repository.ts`, `lib/kyc/state.ts`.

**Завдання:**

- Server-side state machine: `PHASE_1 → PHASE_2 → FUNDED`.
- Перевірка target на закритому P&L.
- Перевірка `tradingDaysCount` ≥ min days.
- Перевірка відсутності відкритих позицій.
- Перевірка KYC `APPROVED` перед Funded credentials.
- Блокування нових ордерів після target (close-only).
- Admin override не може ставити `FUNDED` без тих самих перевірок; потрібен reason + second approval + audit log.

**Acceptance criteria:**

- passing без target/min days/KYC неможливий;
- target досягнуто — нові ордери відхиляються, закриття дозволене;
- manual override не обходить KYC/target;
- є тести на Phase 1/Phase 2/Funded.

---

### P0-4. Static drawdown

**Правила:** 6.2, 18.4.  
**Файли:** `lib/challenges.ts`, `lib/provisioning/challenge-account.ts`, `app/api/checkout/route.ts`, `lib/trading/risk.ts`, UI checkout/terminal.

**Варіант A (рекомендований):**

- Прибрати static add-on з checkout до реалізації.
- Не показувати +15%, не приймати оплату.

**Варіант B:**

- Додати `drawdownMode` в `TradingAccount`.
- Static floor = initial balance − 6%/10%.
- Static floor не рухається від прибутку/payout.
- Відображати режим у терміналі та email.

**Acceptance criteria:**

- неможливо купити static, який не працює;
- якщо static увімкнено — floor фіксований і тестується;
- старі акаунти не змінюють режим автоматично.

---

### P0-5. News blackout + 60-хв pre-window flag

**Правила:** 9.1–9.4.  
**Файли:** `lib/market/economic-calendar.ts`, `lib/trading/engine.ts`, `app/api/trading/order/route.ts`, `app/api/trading/pending/route.ts`, `lib/trading/repository.ts`, email.

**Завдання:**

- Серверний календар high-impact подій.
- На Funded: reject new/increase orders у −5…+5 хв.
- Cancel pending orders за 5 хв до вікна.
- Close-only mode у вікні.
- Позиція, відкрита 5–60 хв до події й залишена через новину, — news-window exposure.
- Позиція, відкрита ≥60 хв до події, — warning only.
- Перше порушення: email із зазначенням акаунта + анулювання прибутку лише за конкретною угодою.
- Друге: closure лише цього Funded-акаунта.
- News flag блокує payout до review.
- Medium-impact — warning; calendar outage — close-only для high-impact.

**Acceptance criteria:**

- прямі API-запити в вікні відхиляються;
- pending не може заповнитися у вікні;
- close-only працює;
- email містить account ID/display ID;
- profit annulment не зачіпає інші угоди;
- payout блокується при flag.

---

### P0-6. Overnight/weekend auto-close

**Правила:** 10.  
**Файли:** `lib/trading/engine.ts`, `app/api/cron/trading/route.ts`, новий scheduler, календар інструментів.

**Завдання:**

- Close-only window перед денним/п’ятничним cutoff.
- Автоматичне закриття позицій.
- Перше порушення: warning + анулювання прибутку з позицій через cutoff.
- Друге: breach.
- Окремі графіки для crypto/index; fallback Friday 21:00 UTC.
- Свята/ранні закриття.

**Acceptance criteria:**

- позиція не може пережити cutoff;
- нові ордери в close-only відхиляються;
- перше/друге порушення обробляються детерміновано;
- тести на DST, weekend, crypto.

---

### P0-7. Account limits + related accounts

**Правила:** 16.  
**Файли:** `app/api/checkout/route.ts`, `lib/provisioning/challenge-account.ts`, admin reconciliation, можливо нова таблиця `RiskGroup`.

**Завдання:**

- Перевірка ≤3 active accounts.
- Aggregate ≤$200k.
- Враховувати active/funded/activated backup/reset.
- Related accounts через KYC/device/IP/payment/copy relationship.
- Перевірка до checkout і до активації.
- Періодичний reconciliation.

**Acceptance criteria:**

- 4-й акаунт не купується;
- перевищення $200k блокується;
- related accounts агрегуються;
- є audit log на блок.

---

### P0-8. Copy trading / cross-account net exposure

**Правила:** 14.1, 14.3.  
**Файли:** `lib/trading/engine.ts`, `app/api/trading/*`, новий risk-group exposure service.

**Завдання:**

- Рахувати net exposure by symbol для risk group.
- Флагувати протилежні позиції між акаунтами.
- Блокувати/зупиняти copy-trading, що створює offsetting exposure.
- Анулювати прибуток із offsetting-угод.
- Не ламати легальний copy trading в одному напрямку.

**Acceptance criteria:**

- long на A + short на B = flag;
- copy trading same direction не блокується;
- є тести на manual/copy-created offsets.

---

### P0-9. Reset cap + frozen rules

**Правила:** 18.2, 18.3.  
**Файли:** checkout/reset flow, `lib/provisioning`, admin.

**Завдання:**

- ≤1 reset на продукт / 30 днів.
- Reset тільки для не-abuse breach.
- Reset fee non-refundable.
- Reset створює новий Phase 1.
- Frozen backup reset — тільки після активації.
- Reset не обходить aggregate limits.
- Кілька reset → manual review.

**Acceptance criteria:**

- другий reset за 30 днів блокується;
- reset після fraud/news second violation блокується;
- frozen reset блокується;
- activated backup reset доступний.

---

### P0-10. Payout hold + manifest error

**Правила:** 17.4, 22.  
**Файли:** `app/api/payouts/route.ts`, admin payout queue, audit.

**Завдання:**

- Payout review hold до 3 робочих днів.
- News/compliance flag блокує payout.
- Manifest error / off-market / stale quote → void trade, no payout.
- Abnormal profit review; default threshold $10,000 або опублікований поріг.
- Якщо payout уже виплачено — offset future payout/balance.
- Payout не скидає drawdown.

**Acceptance criteria:**

- flagged payout не проходить;
- erroneous trade не payout-иться;
- є audit trail;
- можна відкотити/offset.

---

## P1 — після P0

### P1-1. Daily loss timezone/formula

**Статус: виконано.**

- `startOfBerlinDay()` — 00:00 CE(S)T.
- `dailyStartingBalance` + `dailyStartingEquity` зберігаються.
- higher-of використовується для daily loss.
- reset робиться один раз на новий CE(S)T-день.
- перевірено summer/winter UTC offsets.

### P1-2. Trailing fixed-dollar formula

- Rulebook: fixed dollar = 6%/10% of initial balance.
- Engine зараз: % від peak.
- Привести engine до fixed-dollar або змінити правило.
- Тести на приклад $10k / 6%: peak $10,500 → floor $9,900.

### P1-3. Target freeze

- Після target — close-only.
- Автоматичний review.
- Breach під час close-only — звичайні правила.

### P1-4. Consistency by open date

- Рахувати за `openedAt`, не `closedAt`.
- Partial closes агрегувати.
- Risk group разом.
- F19 не змінювати.

### P1-5. News per-account + user risk flag

**Статус: виконано.**

- Account penalty залишається per-account.
- `lib/rules/risk-flags.ts` — user-level flag при ≥2 акаунтах або ≥3 news-порушеннях за 30 днів.
- Під час review — блокувати нові покупки (`/api/checkout`, reset checkout) і payouts (`RISK_REVIEW_HOLD`).
- Автоматичне зняття після 30 чистих днів; ручне flag/clear — `POST /api/admin/users/[id]/risk-flag` з причиною, audit.
- Admin desk показує `RISK REVIEW` badge і дію в risk table.

### P1-6. IP/VPN/session controls

**Статус: виконано.**

- Одна активна сесія — `User.activeSessionId` (було в P0).
- `lib/security/session-risk.ts` — фіксація кожного логіну в `AccessEvent` (IP, device hash, country).
- Сигнали: `NEW_DEVICE`, `NEW_COUNTRY`, `CONCURRENT_COUNTRY`, `IMPOSSIBLE_TRAVEL` (3+ країни/24 год), `VPS_LOCATION_MISMATCH`, `SHARED_ACCESS` (той самий IP + device hash у різних користувачів).
- VPS declared location — поле в profile settings (`User.declaredVpsCountry`, `vpsDeclaredAt`), країна з `x-vercel-ip-country` / `cf-ipcountry` / `x-country-code`.
- Кожен сигнал пише audit `SESSION_RISK_SIGNAL`; усі, крім `SHARED_ACCESS`, дублюються email-ом.
- `AccessEvent` prune — 90 днів, у trading cron.
- Admin desk показує кількість сесійних алертів за 7 днів.

### P1-7. Rule changes

**Статус: виконано.**

- `lib/rules/version.ts` — `RULES_VERSION = '1.6'`, changelog, `NO_ACQUIRED_RIGHT`.
- Commercial terms — `Order.rulesVersion` фіксується в checkout і reset checkout.
- Risk/security changes — immediate with notice: cron `announceRuleChanges()` надсилає лист один раз на трейдера (`User.rulesNotifiedVersion`) з переліком змін і текстом про відсутність набутого права.
- `RULES_NOTICE_SENT` audit на кожного трейдера.
- Публічна сторінка правил поки не публікується (очікує counsel); лист веде на `/rules`, який треба підключити разом з legal pages.

### P1-8. Breach matrix

**Статус: виконано.**

- `lib/rules/breach-matrix.ts` — детерміновані наслідки для кожного типу breach (daily, max, news, overnight, hedging, KYC, inactivity).
- `voidProfit` обмежено `'none' | 'offending-trade'`; daily/max breach скасовують невиплачені payout-и.
- Використовується і admin-діями, і cron-ом (`lib/rules/enforcement.ts`), тому ручний і автоматичний шлях не розходяться.
- Appeal path — `AccountAppeal`, `prisma/sql/account-appeals.sql`, admin appeal queue, `AppealDialog`; рішення приймає адмін, який не виконував breach.

### P1-9. Negative balance protection

**Статус: виконано.**

- Close at zero: equity/balance не можуть піти нижче нуля, платформа поглинає збиток понад fee.
- No liability beyond fee — відображено в breach notice і rulebook.
- Gap rules — engine clamp-ить negative equity перед записом breach.

### P1-10. Public copy alignment

**Статус: виконано.**

- 80/20; no refund; 7-day payout; news windows; reset 2 days; consistency 20%.
- Прибрати старі 90% / on-demand / refund / “no news restrictions”.

### P1-11. Inactivity job

**Статус: виконано.**

- 60 days warning.
- 90 days closure.
- Email + audit.
- 7-day grace after a warning if the 60-day warning was missed.
- Open positions are liquidated before inactivity closure.
- Hourly scan у trading cron.

### P1-12. Frozen backup policy

**Статус: виконано.**

- Non-refundable.
- `backupForAccountId` прив'язує backup до primary; активується лише той backup, чий primary порушено.
- Allocation after activation.
- Reset after activation.
- Expiry on primary pass — статус `EXPIRED`, audit `BACKUP_EXPIRED`, без refund.

---

## P2 — після запуску

- [x] Abuse-дашборд: `GET /api/admin/abuse` + `AbusePanel` на admin desk — news/overnight/hedge/void/payout-hold/risk/session counts, top traders by score, останні audit-події.
- [x] Періодичний reconciliation related accounts: `findRelatedAccountClusters()` (phone або IP + device), годинний cron-скан, денний audit `RELATED_ACCOUNT_CLUSTER`.
- [x] Базовий risk-score: зрозумілі ваги (news 3, overnight/hedge 2, void/hold/session 1, shared access +2), рівні low/medium/high; рішення ухвалює людина або breach matrix.
- [x] Більш детальна аналітика аб’юзу: тренди по тижнях (`trends`), export CSV (`GET /api/admin/abuse/export`), фільтри за типом/трейдером (`category`, `trader`).
- [ ] Автоматичні risk-score евристики: адаптивні ваги, історія score, пороги для авто-review.
- [ ] Розширений news-календар (medium events).
- [ ] Публічна сторінка “Rules changelog” (після legal sign-off).
- [x] Dashboards для news/copy/hedging flags — тижневий графік і drill-down за категорією (filter) на abuse desk.

---

## Тест-план

1. Unit-тести:
   - payout eligibility (кожна умова);
   - drawdown fixed-dollar + payout-adjusted;
   - daily loss timezone;
   - news window ±5/60;
   - reset limits;
   - account limits;
   - net exposure.
2. Integration-тести:
   - прямий POST payout з обходом UI;
   - payout з відкритою позицією;
   - news order у вікні;
   - pending fill у вікні;
   - auto-close weekend;
   - copy long/short across accounts.
3. Regression:
   - успішний payout;
   - phase passing;
   - KYC gate;
   - admin override;
   - build/tsc.

---

**Наступний крок:** P0 і P1 закрито. Перед публічним запуском лишились:
застосувати чотири P1-міграції на production, оновити deployment, отримати
legal sign-off і підтвердити Neon PITR retention. P2 — після запуску.
