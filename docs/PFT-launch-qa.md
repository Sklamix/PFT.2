# PFT.2 — launch QA та legal review

**Дата:** 27 жовтня 2026  
**Джерело правил:** `docs/PFT-rulebook-v1.md` v1.6  
**Статус:** P0/P1 код і QA завершено; production-міграції P1 ще не застосовано; legal review — **не завершено**, потрібен зовнішній юрист.  
**Код:** локальний commit P0-3 leftovers, локальний production build QA — 96/96. Останній production deployment: `dpl_VpnbredSMQnoZ9iDzCPnFdHfFyLW` (до P1-5…P1-9, P1-12).

---

## 1. Що перевірено в коді

| Блок | Перевірка | Стан |
|---|---|---|
| Payout eligibility | KYC, 7 днів, flat book, 3 profitable days, consistency 20%, min amount, one pending, holds | ✅ |
| Payout drawdown | `riskEquity = equity + withdrawnProfit`, fixed-dollar trailing, static floor | ✅ |
| Passing | server-side target + min days + flat + KYC; target lock cancels existing pending orders; auto pass + auto-funding після KYC | ✅ |
| Static / trailing | `drawdownMode` з checkout до engine і термінала | ✅ |
| News | ±5 хв блокування, 5–60 хв exposure, 60+ warning, annulment, second closure, 7-day hold | ✅ |
| Overnight / weekend | close-only вікно, auto-close, cancel pending | ✅ |
| Account limits | 3 active / $200k, phone + IP/device, checkout/provisioning/standby/reconciliation guards | ✅ |
| Cross-account hedging | net exposure detection + `CROSS_ACCOUNT_HEDGE` audit | ✅ detection |
| Reset | 20% / 2 дні / fresh Phase 1 / 1 per 30 days / frozen blocked | ✅ admin flow |
| Payout hold + void | hold/clear + trade void + abnormal profit flag + admin UI | ✅ |
| Daily loss | 00:00 Europe/Berlin, higher-of(balance, equity) snapshot | ✅ |
| Inactivity | 60-day warning, 90-day closure, 7-day grace, liquidation, audit | ✅ |
| Funding approval | request + different-admin approval + reject + 24h TTL + admin UI | ✅ |
| Single session | `activeSessionId`, new login invalidates old cookie, logout clears session | ✅ |
| Session risk (P1-6) | login fingerprint, new device/country, concurrent country, impossible travel, VPS mismatch, shared access, 90-day retention | ✅ |
| Risk flags (P1-5) | user-level flag at ≥2 accounts / ≥3 news violations in 30 days, purchase + payout pause, 30-day auto-clear, admin flag/clear | ✅ |
| Rules versioning (P1-7) | `RULES_VERSION`, `Order.rulesVersion`, one-time cron notice, `RULES_NOTICE_SENT`, no-acquired-right text | ✅ |
| Breach matrix (P1-8) | deterministic consequences per breach type, unpaid payouts cancelled, appeals decided by a non-acting admin | ✅ |
| Negative balance (P1-9) | equity clamped at zero, platform absorbs loss beyond the fee | ✅ |
| Frozen backups (P1-12) | linked to primary, only that backup activates, expires on primary pass | ✅ |
| Abuse monitor (P2) | audit counts by category, trader score/level, recent evidence, related-account clusters | ✅ |
| Related-account snapshot (P2) | union of phone and IP+device links, hourly cron scan, daily `RELATED_ACCOUNT_CLUSTER` audit | ✅ |
| Public copy | 80%, weekly payouts, no refund, news windows, reset 2 days, CE(S)T, PFT terminal | ✅ |

**Команди:**

- `npx tsc --noEmit` — passed.
- `npm run build` — passed.
- `npm run qa:smoke` — 96/96 на локальному production build.
- `npm run doctor` — readiness self-check (env, schema columns, cron freshness).

---

## 2. Production migrations

**Статус: шість базових міграцій застосовано 27.10.2026. Чотири P1-міграції ще не застосовано.**

Покроковий handoff для оператора: `docs/PFT-production-rollout.md`.

- Deployment: `dpl_7gstvsBwbYbFipxCF4aQepteTajH`
- Поточний release: `dpl_VpnbredSMQnoZ9iDzCPnFdHfFyLW` (post-action reviews + risk-manager desk fix)
- URL: `https://pft-app-prod.vercel.app`
- Спосіб: guarded `prebuild` із `PFT_STRESS_MIGRATIONS=1`; після успішного build змінну видалено.
- Build log підтвердив усі шість файлів: `[pft stress] all six migrations applied`.
- Production перевірено: `/`, `/login`, `/admin/login` → 200; `/api/stats` → `source=database`.

Для повторного запуску в іншому середовищі — ідемпотентно, без `prisma db push`:

```powershell
$line = Get-Content .env.local | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
$env:DATABASE_URL = $line.Substring('DATABASE_URL='.Length).Trim().Trim('"')

npx prisma db execute --file prisma/sql/static-drawdown.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/account-fingerprints.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/account-resets.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/daily-loss-cet.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/trade-voids.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/active-session.sql --schema prisma/schema.prisma
```

P1-міграції (застосувати перед наступним deploy):

```powershell
npx prisma db execute --file prisma/sql/account-appeals.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/risk-flags-and-backups.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/session-risk.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/rules-versioning.sql --schema prisma/schema.prisma
```

Після міграцій:

- `npx prisma generate` (якщо build не робить це автоматично);
- Cloudflare worker має актуальний `CRON_SECRET` — перевірено 27.10.2026 (§`docs/PFT-operations-runbook.md`);
- `/api/cron/trading` повертає `inactivity`, `limitReconciliation`, `crossAccountHedges`, `enforcement`, `riskFlags`, `rules` — перевірено живим cron-циклом локально;
- `npm run doctor` не має показувати відсутні колонки з `REQUIRED_COLUMNS`.

### 2.1. Readiness self-check

`npm run doctor` (`scripts/readiness.ts`) перевіряє env-групи, доступ до БД, наявність
усіх міграційних колонок, heartbeat cron/market data, кількість адмінів, pricing rows і
легальні документи. Локально очікувано `9 blockers`:

- відсутні `RESEND_API_KEY` / `RESEND_FROM_EMAIL`, `NOWPAYMENTS_API_KEY` / IPN secret,
  `DIDIT_WEBHOOK_SECRET` — локальний `.env.local` навмисно без провайдерських ключів;
- один адмін у локальній БД (для two-admin approval потрібні двоє);
- legal-сторінки не опубліковані (очікує counsel).

На production перед deploy усі блокери, крім legal, мають бути закриті; `SCHEMA` має
показувати всі колонки, `CRON` — свіжий `INACTIVITY_SCAN_RUN`.

---

## 3. Manual QA перед запуском

**Статус: локальний production-build QA пройдено — 96/96.**

Запуск:

```powershell
npm run build
npm run start -- --port 3100
# в іншому терміналі, з DATABASE_URL у середовищі:
$env:QA_BASE = 'http://127.0.0.1:3100'
npm run qa:smoke
```

`scripts/qa-smoke.cjs` створює тимчасових QA-адмінів і трейдерів, перевіряє auth,
single-session, two-admin approval, payout gate, breach matrix, automated enforcement,
appeals, paid reset, frozen backups, risk flags, session risk, rules notices, після
чого видаляє тестові записи.

**Знайдено і виправлено під час QA:** після logout старий підписаний cookie
залишався валідним, бо `activeSessionId = null` трактувався як «дозволити».
Тепер `getTraderSession` вимагає точний збіг `session.sessionId` з
`User.activeSessionId`; legacy-cookie та cookie після logout відхиляються.

### 3.1. Auth / session

1. Увійти в акаунт у браузері A.
2. Увійти тим самим акаунтом у браузері B.
3. Оновити сторінку в A → має вийти з сесії (401 / redirect на login).
4. Вийти в B → сесія B очищена, повторний вхід працює.
5. Перевірити Google login, email-code login, set-password — усі видають нову єдину сесію.

### 3.2. Account override approval (будь-який status)

1. Адмін A відкриває акаунт → Override → вибирає status (наприклад `PASSED_PHASE_1`) і вводить причину.
2. Система показує «override requested», акаунт **не** змінює статус.
3. Адмін A бачить запит у «Pending account overrides» з target status і позначкою «Awaiting approval from a different admin».
4. Адмін B бачить запит, натискає Approve override, вводить причину.
5. Акаунт отримує новий status; для `FUNDED` phase `FUNDED`, balance/equity скинуті до initial, metrics = 0.
6. Повторити з Reject → статус не змінюється, запит зникає з черги.
7. Перевірити, що запит старший за 24 год показується як Expired і не апрувиться.
8. Спробувати створити другий запит з іншим status → `409`, спершу треба відхилити наявний.
9. Спробувати зберегти override без причини → кнопка неактивна, API повертає `400`.

### 3.3. Payout gate

1. Funded-акаунт молодший за 7 днів → payout відхилено.
2. Відкрита позиція або pending-ордер → payout відхилено.
3. Менше 3 profitable days → відхилено.
4. Один день > 20% прибутку → відхилено (consistency).
5. Активний hold → відхилено.
6. Усі умови виконані → payout створюється, balance не змінює peak/floor.

### 3.4. News

1. Evaluation: відкриття за 2 хв до high-impact → дозволено.
2. Funded: відкриття за 2 хв до події → технічно дозволено, але створює violation.
3. Перше порушення → анульовано прибуток лише цієї угоди + email з display ID.
4. Друге порушення на тому ж Funded → закрито лише цей акаунт.
5. Позиція, відкрита за 30 хв до події → exposure violation.
6. Позиція, відкрита за 90 хв → warning email, без анулювання.
7. Payout hold на 7 днів після news-порушення.

### 3.5. Weekend / overnight

1. У close-only вікні нові ордери блокуються, закриття дозволене.
2. Позиція, залишена на cutoff, закривається автоматично.
3. Pending-ордери скасовуються.
4. Перевірити індекси та крипто окремо.

### 3.6. Limits / reset / inactivity

1. 4-й активний акаунт → checkout/provisioning blocked.
2. Сумарна алюкація > $200k → blocked.
3. Reset: 20% discount, лише 2 дні, новий Phase 1, 1 раз на 30 днів, frozen blocked.
4. 60 днів без closed trade → warning email + audit.
5. 90 днів → closure, позиції ліквідовано, email, audit.
6. Після нової угоди warning стає неактуальним.

### 3.7. Post-action reviews

1. Адмін A робить breach kill-switch → акаунт одразу `BREACHED_*`, у черзі `Post-action reviews` з'являється запис `Breach kill-switch`.
2. Адмін A не може натиснути Confirm/Flag для власної дії (`403`).
3. Адмін B натискає Confirm або Flag і вводить note → запис зникає з черги, в audit є `ACCOUNT_ACTION_REVIEW_CONFIRMED` / `_FLAGGED`.
4. Повторити для admin reset → review типу `Admin reset` на новому акаунті.
5. Note обов'язковий; порожній note → `400`.
6. Через 24 год запис показується як Overdue, але лишається доступним для review.

### 3.8. Automated breach enforcement + appeals

1. Залишити акаунт із пробитим max drawdown → cron закриває його без участі адміна.
2. Перевірити audit `ACCOUNT_BREACH` з `actorId = null` і post-action review `Automated enforcement`.
3. Повторний cron-цикл не створює дублікат (idempotent за `frozenAt`).
4. Невиплачені payout-и акаунта переходять у `REJECTED`.
5. Трейдер подає appeal; адмін, який виконував breach, не може його вирішити (`403`).
6. Інший адмін overturn → акаунт повертається в попередній phase/status.

### 3.9. Paid reset + frozen backup

1. Breached-акаунт у межах 2 днів показує 20% discount; поза вікном — повна ціна.
2. Checkout створює order; після оплати webhook провізіонить новий Phase 1.
3. Другий reset того ж продукту за 30 днів блокується (`provisioningBlocked`).
4. Frozen backup не можна скинути до активації.
5. Покупка з backup-ом створює два акаунти: primary і `FROZEN_STANDBY`, прив'язаний через `backupForAccountId`.
6. Breach primary активує лише свій backup; passing primary переводить backup у `EXPIRED` без refund.

### 3.10. Risk flags

1. Два news-порушення на різних акаунтах одного трейдера → cron ставить user-level flag.
2. Новий checkout і payout повертають `RISK_REVIEW_HOLD` / `403`.
3. Адмін clear без причини → `400`; з причиною → flag знято, payout gate знову проходить eligibility.
4. Через 30 чистих днів flag знімається автоматично.

### 3.11. Session risk

1. Логін з іншої країни → `NEW_COUNTRY` + `CONCURRENT_COUNTRY` audit.
2. Третя країна за 24 год → `IMPOSSIBLE_TRAVEL`.
3. Задекларована VPS-країна в profile settings + логін з іншої → `VPS_LOCATION_MISMATCH` + email.
4. Той самий IP + device hash у двох користувачів → `SHARED_ACCESS` (без email).
5. Admin desk показує `SESSION ALERTS · N in 7 days`.
6. `AccessEvent` старші 90 днів видаляються cron-ом.

### 3.12. Rules versioning

1. Новий checkout зберігає `Order.rulesVersion = '1.6'`.
2. Трейдер зі старою версією отримує один лист про зміни; повторний cron не дублює.
3. Audit `RULES_NOTICE_SENT` містить `userId`, `previousVersion`, перелік змін.
4. Breach email містить текст про відсутність набутого права.

### 3.13. Abuse monitor + related accounts

1. Admin desk показує `Abuse monitor` з counts за 30 днів і списком трейдерів зі score.
2. News/overnight/hedge/void/payout-hold/risk/session події з'являються в `Latest evidence`.
3. Двоє користувачів з однаковим телефоном або IP + device hash показуються одним cluster-ом.
4. `OVER LIMIT` з'являється, коли cluster перевищує 3 акаунти або $200k.
5. `RISK_MANAGER` не має доступу до `/api/admin/abuse` (`403`), `ADMIN` — `200`.
6. Cron повертає `relatedAccounts` і раз на добу пише audit `RELATED_ACCOUNT_CLUSTER`.
7. Панель показує тижневі тренди (`trends`) і кількість подій (`evidenceTotal`).
8. Фільтр за категорією (`category=NEWS` тощо) звужує `recent` і тренди; фільтр за трейдером (`trader`) звужує список трейдерів.
9. `Export CSV` (`GET /api/admin/abuse/export`) віддає CSV з усіма подіями поточного фільтра.
10. Score адаптивний (recency + escalation); у таблиці трейдерів є sparkline історії score.
11. Щотижня cron пише `ABUSE_SCORE_SNAPSHOT`; score ≥12 → `ABUSE_SCORE_AUTO_REVIEW` (ручний review, без авто-наслідку).

### 3.14. Passing, auto-funding і target lock

1. Акаунт досяг closed-P&L target і min trading days → нові ордери відхиляються (`409`).
2. Pending-ордери, створені до target lock, скасовуються (`CANCELLED`) з audit `PENDING_ORDERS_CANCELLED`; вони не можуть заповнитися.
3. Passing у cron переводить Phase 1 → Phase 2 або фінальну фазу; залишкові pending-ордери скасовуються.
4. KYC approval для passed-акаунта автоматично переводить його в `FUNDED` без адмінського override; balance = `initialBalance`.
5. Auto-funding пише audit `ACCOUNT_AUTO_FUNDED` з `actorId = null`; повторний KYC callback не створює дубль.

---

## 4. Legal review — блокер запуску

**Статус: очікує counsel. Сторінки навмисно не опубліковані**, щоб не публікувати
неперевірені юридичні документи. Після отримання фінального тексту й реквізитів
додати `/legal/terms`, `/legal/privacy`, `/legal/risk`, `/legal/aml`, `/legal/refund`
та оновити footer/checkout.

Публічні юридичні сторінки **відсутні** в коді: Terms of Service, Privacy Policy, Risk Disclosure, AML/KYC Policy. Зараз footer і checkout ведуть на `#top`, `#faq`, `#rules`. Це треба закрити до запуску.

### 4.1. Що має покрити юрист

- **Terms of Service**
  - simulated accounts, не брокер, не депозит;
  - 80/20 profit split, weekly payout, non-refundable fee;
  - evaluation rules, breach, reset, inactivity;
  - news/overnight/weekend restrictions;
  - 3 accounts / $200k aggregate, related-account aggregation;
  - cross-account hedging / copy trading;
  - payout hold, trade void, manifest error;
  - KYC/AML, sanctions, restricted jurisdictions;
  - limitation of liability, dispute resolution, governing law.
- **Risk Disclosure**
  - leveraged/CFD risk, simulated performance, no investment advice, no custody.
- **AML/KYC Policy**
  - identity verification, sanctions screening, source of funds, payout wallet checks, record retention.
- **Privacy Policy**
  - GDPR/UK GDPR basis, data categories (IP, device hash, KYC, payment), retention, processors, rights.
- **Refund Policy**
  - evaluation fee non-refundable; reset/backup non-refundable; chargeback policy.

### 4.2. Відкриті юридичні питання

1. **Юрисдикція та entity.** Яка компанія є контрпартією: `Professional Funded Trader Ltd.`? Де зареєстрована? Яке governing law?
2. **Чи є діяльність regulated activity** у цільових юрисдикціях (особливо EU/UK/US). Потрібен висновок counsel до відкриття трафіку.
3. **Restricted jurisdictions list** — хто і як підтримує, як блокується signup/checkout.
4. **Payout characterization** — performance reward, не прибуток від інвестування; податкові наслідки для трейдера.
5. **KYC vendor / data residency** — який провайдер, де зберігаються документи, retention.
6. **Chargebacks** — чи можна відмовити в поверненні після початку evaluation; як це сформулювати.
7. **News trading / market data** — чи потрібні дозволи на розповсюдження calendar/quote даних.
8. **Copy trading / signal providers** — дозволено, але потрібно описати, що це не керування чужими коштами.
9. **Inactivity closure** — чи достатньо 60/90 днів і email-warning для одностороннього закриття.
10. **Arbitration / class action waiver** — чи застосовно в обраних юрисдикціях.

### 4.3. Що підготувати перед counsel

- [x] фінальний rulebook v1.6 (включно з §29 — версії правил і no acquired right);
- [ ] checkout flow і pricing;
- [ ] payout flow і KYC flow;
- [ ] список юрисдикцій, де планується маркетинг;
- [ ] data map (IP, device hash, session risk signals, declared VPS country, KYC, payment, trading history);
- [ ] draft Terms / Risk / AML / Privacy / Refund.

**Після юридичного підпису:** додати сторінки `/legal/terms`, `/legal/privacy`, `/legal/risk`, `/legal/aml`, `/legal/refund`, оновити footer і checkout links. Це окремий PR, бо це публічна копія.

---

## 5. Go / No-Go

| Критерій | Стан |
|---|---|
| TypeScript + production build | ✅ |
| Усі 6 базових SQL-міграцій застосовані на production | ✅ 27.10.2026 |
| P1-міграції застосовані на production | ⏳ `account-appeals`, `risk-flags-and-backups`, `session-risk`, `rules-versioning` |
| Manual QA §3 пройдено | ✅ 96/96 (локальний production build) |
| Readiness self-check `npm run doctor` | ✅ локально; production — після міграцій |
| Production deployment оновлено | ⏳ після P1-міграцій |
| Legal pages опубліковані | ⏳ очікує counsel |
| Legal counsel sign-off | ⏳ очікує counsel |
| Cloudflare cron secret і розклад перевірені | ✅ `* * * * *`, `wrangler tail` → `trading cron processed` |
| Backup / rollback plan | ✅ `docs/PFT-operations-runbook.md`, `npm run db:backup` |
| Neon PITR retention підтверджено | ⏳ operator action |
| Production env: `RESEND_FROM_EMAIL`, `NOWPAYMENTS_IPN_SECRET`, Didit keys | ⏳ operator action |

**Рішення:** інженерно P0/P1 готово, локальний QA зелений. Публічний запуск блокується
юридичними документами (counsel), застосуванням P1-міграцій на production,
production env secrets і підтвердженням Neon PITR retention.
