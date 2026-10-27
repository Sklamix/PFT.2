# PFT.2 — production rollout P1/P2

**Дата:** 27 жовтня 2026  
**Код:** `P0-3 leftovers` (local), `4975284` (P2), `58f70e5` (P1-6/P1-7)  
**Призначення:** покроковий handoff для оператора з доступом до Vercel/Neon.  
**Стан:** локально `npx tsc --noEmit`, `npm run build`, `npm run qa:smoke` (96/96) — зелені.

> Production `DATABASE_URL` у Vercel має тип **Secret** і не витягується через `vercel env pull`.
> Тому міграції та deploy виконує оператор із доступом до Neon/Vercel.

---

## 0. Передумови

- [ ] Доступ до Vercel проєкту `andripigij-5023/pft-app-prod`.
- [ ] Production connection string з Neon dashboard (не з Vercel env).
- [ ] Доступ до Cloudflare worker `pft-market-worker` (перевірити `CRON_SECRET`).
- [ ] Підтверджений Neon PITR retention (мінімум 24 год).

---

## 1. Backup перед міграціями

```powershell
$env:DATABASE_URL = '<production connection string>'
npm run db:backup -- --out backups/pre-p1-2026-10-27
```

Перевірити `backups/pre-p1-2026-10-27/manifest.json`: `finishedAt` заповнений, `totalRows > 0`.
Копію зберегти поза репозиторієм.

---

## 2. Міграції (ідемпотентні, без `prisma db push`)

```powershell
npx prisma db execute --file prisma/sql/account-appeals.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/risk-flags-and-backups.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/session-risk.sql --schema prisma/schema.prisma
npx prisma db execute --file prisma/sql/rules-versioning.sql --schema prisma/schema.prisma
```

Очікувано: `Script executed successfully.` для кожного файлу.

Перевірка колонок:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'User'
  AND column_name IN ('riskFlaggedAt','riskFlagReason','declaredVpsCountry','vpsDeclaredAt','rulesNotifiedVersion');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'TradingAccount' AND column_name = 'backupForAccountId';

SELECT column_name FROM information_schema.columns
WHERE table_name = 'Order' AND column_name = 'rulesVersion';
```

---

## 3. Environment variables

| Variable | Стан | Дія |
|---|---|---|
| `DATABASE_URL` | ✅ Secret | не змінювати |
| `CRON_SECRET` | ✅ Secret | не змінювати; той самий у Cloudflare |
| `NOWPAYMENTS_API_KEY` | ✅ Secret | не змінювати |
| `NOWPAYMENTS_IPN_KEY` | ✅ Secret | код приймає як fallback для IPN secret |
| `RESEND_API_KEY` | ✅ Secret | не змінювати |
| `RESEND_FROM_EMAIL` | ❌ відсутній | додати адресу на верифікованому домені |
| `DIDIT_API_KEY` | ❌ відсутній | додати перед відкриттям KYC |
| `DIDIT_WORKFLOW_ID` | ❌ відсутній | додати |
| `DIDIT_WEBHOOK_SECRET` | ❌ відсутній | додати; без нього KYC webhook відхиляється |

```powershell
npx vercel env add RESEND_FROM_EMAIL production
npx vercel env add DIDIT_API_KEY production
npx vercel env add DIDIT_WORKFLOW_ID production
npx vercel env add DIDIT_WEBHOOK_SECRET production
```

Секрети вводити вручну в CLI, не зберігати в репозиторії.

---

## 4. Pre-deploy перевірки

```powershell
npx tsc --noEmit
npm run build
# локальний production build
npm run start -- --port 3100
# в іншому терміналі
$env:QA_BASE = 'http://127.0.0.1:3100'
npm run qa:smoke
```

Очікувано: `96/96 checks passed`.

Readiness (з production env, після міграцій):

```powershell
$env:DATABASE_URL = '<production connection string>'
npm run doctor
```

Очікувано: без `BLOCKER` у `SCHEMA`/`DATABASE`/`CRON`; legal лишається блокером до counsel.

---

## 5. Deploy

```powershell
npx vercel --prod --yes
```

Зафіксувати deployment ID з виводу.

---

## 6. Post-deploy перевірки

```powershell
Invoke-WebRequest https://pft-app-prod.vercel.app/ -UseBasicParsing
Invoke-WebRequest https://pft-app-prod.vercel.app/login -UseBasicParsing
Invoke-WebRequest https://pft-app-prod.vercel.app/admin/login -UseBasicParsing
Invoke-RestMethod https://pft-app-prod.vercel.app/api/stats
```

Очікувано: `200`, `200`, `200`, `source=database`.

Cron (один цикл):

```powershell
cd cloudflare/market-worker
npx wrangler tail --format pretty
```

Очікувано `trading cron processed`. Відповідь `/api/cron/trading` (за потреби вручну з `CRON_SECRET`)
має містити `enforcement`, `riskFlags`, `rules`, `relatedAccounts`, `limitReconciliation`,
`crossAccountHedges`, `inactivity`.

Admin desk:

- [ ] `Release readiness` без schema/env блокерів (legal — окремо).
- [ ] `Abuse monitor` відкривається, counts і clusters рендеряться.
- [ ] Risk table показує `RISK REVIEW` / `SESSION ALERTS`, якщо є сигнали.
- [ ] Payout gate повертає `RISK_REVIEW_HOLD` для flagged трейдера.
- [ ] Appeals queue доступна; рішення не може ухвалити адмін, який виконав breach.

Трейдер:

- [ ] Логін з іншої країни створює `SESSION_RISK_SIGNAL` в audit.
- [ ] VPS-країна зберігається в profile settings.
- [ ] Після зміни `RULES_VERSION` приходить один лист (не дубль).

---

## 7. Rollback

```powershell
npx vercel ls pft-app-prod --prod
npx vercel rollback <deployment-url-or-id> --yes
```

Міграції additive та idempotent — код можна відкотити, колонки лишити.
Дані — тільки через Neon PITR branch, без destructive SQL.

---

## 8. Перші 24 години

- [ ] Перевірити `/api/cron/trading` логи щогодини (Vercel Hobby зберігає 12 год запитів).
- [ ] Перевірити, що automated breach enforcement не створює дублікатів review.
- [ ] Перевірити payout queue: нові payout-и проходять eligibility gate.
- [ ] Перевірити, що жоден трейдер не отримав повторний rules notice.
- [ ] Зафіксувати всі інциденти в ops log.

---

## 9. Підпис

| Роль | Ім'я | Дата | Підпис |
|---|---|---|---|
| Operator (Vercel/Neon) | | | |
| Risk lead | | | |
| Legal counsel (pages only) | | | |
