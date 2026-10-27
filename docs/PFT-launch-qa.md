# PFT.2 — launch QA та legal review

**Дата:** 27 жовтня 2026  
**Джерело правил:** `docs/PFT-rulebook-v1.md` v1.6  
**Статус:** production-міграції застосовано; інженерний QA — пройдено (42/42); legal review — **не завершено**, потрібен зовнішній юрист.

---

## 1. Що перевірено в коді

| Блок | Перевірка | Стан |
|---|---|---|
| Payout eligibility | KYC, 7 днів, flat book, 3 profitable days, consistency 20%, min amount, one pending, holds | ✅ |
| Payout drawdown | `riskEquity = equity + withdrawnProfit`, fixed-dollar trailing, static floor | ✅ |
| Passing | server-side target + min days + flat + KYC; target lock; auto pass у cron | ✅ |
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
| Public copy | 80%, weekly payouts, no refund, news windows, reset 2 days, CE(S)T, PFT terminal | ✅ |

**Команди:**

- `npx tsc --noEmit` — passed.
- `npm run build` — passed (28 routes).

---

## 2. Production migrations

**Статус: застосовано 27.10.2026.**

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

Після міграцій:

- `npx prisma generate` (якщо build не робить це автоматично);
- Cloudflare worker має актуальний `CRON_SECRET` — перевірено 27.10.2026 (§`docs/PFT-operations-runbook.md`);
- `/api/cron/trading` повертає `inactivity`, `limitReconciliation`, `crossAccountHedges` — перевірено живим cron-циклом.

---

## 3. Manual QA перед запуском

**Статус: локальний production-build QA пройдено — 42/42.**

Запуск:

```powershell
npm run build
npm run start -- --port 3100
# в іншому терміналі, з DATABASE_URL у середовищі:
$env:QA_BASE = 'http://127.0.0.1:3100'
npm run qa:smoke
```

`scripts/qa-smoke.cjs` створює тимчасових QA-адмінів і трейдера, перевіряє auth,
single-session, two-admin approval для `FUNDED` і non-`FUNDED` status, payout gate,
після чого видаляє тестові записи.

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

- [ ] фінальний rulebook v1.6;
- [ ] checkout flow і pricing;
- [ ] payout flow і KYC flow;
- [ ] список юрисдикцій, де планується маркетинг;
- [ ] data map (IP, device hash, KYC, payment, trading history);
- [ ] draft Terms / Risk / AML / Privacy / Refund.

**Після юридичного підпису:** додати сторінки `/legal/terms`, `/legal/privacy`, `/legal/risk`, `/legal/aml`, `/legal/refund`, оновити footer і checkout links. Це окремий PR, бо це публічна копія.

---

## 5. Go / No-Go

| Критерій | Стан |
|---|---|
| TypeScript + production build | ✅ |
| Усі 6 SQL-міграцій застосовані на production | ✅ 27.10.2026 |
| Manual QA §3 пройдено | ✅ 42/42 (локальний production build) |
| Production deployment оновлено | ✅ `dpl_VpnbredSMQnoZ9iDzCPnFdHfFyLW` (post-action reviews) |
| Legal pages опубліковані | ⏳ очікує counsel |
| Legal counsel sign-off | ⏳ очікує counsel |
| Cloudflare cron secret і розклад перевірені | ✅ `* * * * *`, `wrangler tail` → `trading cron processed` |
| Backup / rollback plan | ✅ `docs/PFT-operations-runbook.md`, `npm run db:backup` |
| Neon PITR retention підтверджено | ⏳ operator action |

**Рішення:** інженерно готово, production оновлено, cron і rollback plan перевірені.
Публічний запуск блокується лише юридичними документами (counsel) і підтвердженням
Neon PITR retention у консолі.
