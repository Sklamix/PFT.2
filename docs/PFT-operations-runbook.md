# PFT.2 — operations runbook

**Дата:** 27 жовтня 2026  
**Призначення:** cron, backup, restore і rollback для production `pft-app-prod`.

---

## 1. Production surfaces

| Surface | Value |
|---|---|
| App | `https://pft-app-prod.vercel.app` |
| Vercel project | `andripigij-5023/pft-app-prod` |
| Cloudflare worker | `pft-market-worker` |
| Database | Neon Postgres (production) |
| Health checks | `/`, `/login`, `/admin/login`, `/api/stats` |

---

## 2. Cron

### 2.1. Що запускається

| Trigger | Schedule | Endpoint |
|---|---|---|
| Cloudflare worker | `* * * * *` (щохвилини) | `POST /api/cron/trading` |
| Cloudflare worker | `* * * * *` | `GET /api/cron/market-conditions` |
| Cloudflare worker | `* * * * *` | `GET /api/cron/economic-calendar` |
| Vercel cron (`vercel.json`) | `0 0 1,15 * *` | `/api/stats/recalculate` |

Cloudflare worker також пише one-minute candles у `MarketCandle` для FX, індексів, металу та BTC.

`POST /api/cron/trading` виконує:

- pending orders, SL/TP, session cutoff;
- passing evaluation;
- inactivity scan (60/90 днів);
- account-limit reconciliation;
- cross-account hedge detection;
- news warnings.

### 2.2. Перевірено 27.10.2026

- Cloudflare schedule через API: `* * * * *`, створено 22.10.2026.
- Worker secrets присутні: `CRON_SECRET`, `DATABASE_URL`, `PFT_APP_URL`.
- `wrangler tail` підтвердив живий запуск:
  - `economic calendar cron processed`;
  - `conditions cron processed`;
  - `trading cron processed`;
  - `stored EURUSD:... XAUUSD:...`.
- Отже `CRON_SECRET` у Cloudflare збігається з Vercel, а worker має доступ до production DB.
- Vercel request logs: `/api/cron/trading` → `POST 200` щохвилини, зокрема на поточному deployment `dpl_VpnbredSMQnoZ9iDzCPnFdHfFyLW`.

### 2.3. Повторна перевірка

```powershell
cd cloudflare/market-worker
npx wrangler secret list
npx wrangler tail --format pretty
```

Очікувано щохвилини:

```
"* * * * *" @ ... - Ok
  (info) [pft market worker] trading cron processed
```

Перевірка з боку Vercel:

```powershell
npx vercel logs requests --since 10m --query 'requestPath = "/api/cron/trading"'
```

Очікувано: `requestMethod: POST`, `httpStatus: 200` щохвилини.

Перевірка schedule через Cloudflare API:

```powershell
$cfg = Get-Content "$env:APPDATA\xdg.config\.wrangler\config\default.toml" -Raw
$token = [regex]::Match($cfg, 'oauth_token\s*=\s*"([^"]+)"').Groups[1].Value
Invoke-RestMethod `
  -Uri 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/pft-market-worker/schedules' `
  -Headers @{ Authorization = "Bearer $token" }
```

Без `CRON_SECRET` або з неправильним значенням:

- `/api/cron/trading` → `401`;
- у `wrangler tail` буде `Trading cron failed 401`.

### 2.4. Vercel cron

`vercel.json` містить лише `/api/stats/recalculate` двічі на місяць. Vercel додає
`Authorization: Bearer $CRON_SECRET`, якщо змінна є в проєкті. Перевірка:

```powershell
npx vercel crons ls
```

---

## 3. Backup

### 3.1. Layers

1. **Neon PITR / branches** — основне джерело повного restore.
2. **Logical JSON export** — `npm run db:backup` для точкового відновлення рядків і
   перевірки цілісності перед релізом.
3. **Vercel deployment history** — код і build artifacts для rollback.

### 3.2. Logical export

```powershell
$env:DATABASE_URL = '<production connection string>'
npm run db:backup
# або
npm run db:backup -- --out backups/pre-deploy-2026-10-27
```

Скрипт експортує **всі** Prisma-моделі в `backups/<timestamp>/<Model>.json` і пише
`manifest.json` із кількістю рядків і SHA-256 кожного файлу.

Перевірено локально 27.10.2026: 21 модель, 14 022 рядки, manifest створено.

Правила:

- `backups/` у `.gitignore`; не комітити і не заливати у Vercel.
- Зберігати копії поза репозиторієм ( encrypted cloud storage / operator machine).
- Перед кожним релізом зі зміною схеми — обов'язковий export.
- Після export перевірити `manifest.json`: `finishedAt` заповнений, `totalRows > 0`.

### 3.3. Neon PITR — що підтвердити в консолі

Operator з доступом до Neon проєкту має перевірити і зафіксувати:

- [ ] Project → Settings → **Restore window / PITR** увімкнено.
- [ ] Retention покриває мінімум 24 години (для launch достатньо; ціль — 7 днів).
- [ ] Є окремий branch або database для restore-перевірок.
- [ ] Відомо, який connection string відповідає production (Neon dashboard → Connect).

Без цих даних PITR не можна вважати перевіреним, навіть якщо код і export готові.

### 3.4. Restore drill (щотижня або перед великим релізом)

1. Створити Neon branch від production на потрібний timestamp.
2. Підключитися до branch і виконати:
   ```sql
   SELECT count(*) FROM "User";
   SELECT count(*) FROM "TradingAccount";
   SELECT count(*) FROM "TradeHistory";
   ```
3. Порівняти з `manifest.json` останнього export (допустимий drift — нові рядки після export).
4. Перевірити 2–3 конкретні акаунти/трейди.
5. Видалити drill branch.

---

## 4. Rollback

### 4.1. Матриця рішень

| Situation | Action |
|---|---|
| Bad code deploy, schema не змінювалась | Vercel instant rollback |
| Bad code deploy, schema additive | Vercel rollback; нові колонки/таблиці лишити (вони зворотно сумісні) |
| Помилка в даних / масова корупція | Зупинити writes, Neon PITR branch, перевірити, перемкнути `DATABASE_URL` |
| Зламаний payment webhook | Вимкнути provider keys у Vercel, потім rollback коду |
| Зламаний cron | Вимкнути Cloudflare trigger (`crons = []` + deploy) або worker, потім rollback |

### 4.2. Code rollback

```powershell
npx vercel ls pft-app-prod --prod
npx vercel rollback <deployment-url-or-id> --yes
npx vercel rollback status
```

Поточний rollback target на 27.10.2026:

- `dpl_VpnbredSMQnoZ9iDzCPnFdHfFyLW` — post-action reviews (current);
- `dpl_CRJjHghpxG2KQZwki6bDPsWqjbjg` — post-action reviews без risk-manager fix;
- `dpl_A7pyV5EMN8nXjcFmfSFsNw57w1ns` — generic override approval;
- `dpl_7gstvsBwbYbFipxCF4aQepteTajH` — release без generic override approval.

Rollback коду **не** відкочує SQL-міграції. Усі шість stress-test міграцій additive та
idempotent, тому старіший код продовжує працювати з новими колонками.

### 4.3. Database rollback

1. Зупинити writes:
   - за потреби вимкнути checkout/webhook keys у Vercel;
   - попередити support.
2. Neon → Branches → **Restore** на timestamp до інциденту.
3. Перевірити branch запитами з §3.4.
4. Оновити production `DATABASE_URL` у Vercel на restored branch (sensitive var).
5. Redeploy або restart, щоб нові connections пішли на restored DB.
6. Перевірити `/api/stats`, логін трейдера, логін адміна, payout queue.
7. Зафіксувати інцидент в audit/ops log.

Не робити `prisma db push` і не запускати destructive SQL на production.

### 4.4. Post-rollback checks

```powershell
Invoke-WebRequest https://pft-app-prod.vercel.app/ -UseBasicParsing
Invoke-WebRequest https://pft-app-prod.vercel.app/login -UseBasicParsing
Invoke-WebRequest https://pft-app-prod.vercel.app/admin/login -UseBasicParsing
Invoke-RestMethod https://pft-app-prod.vercel.app/api/stats
```

Очікувано: `200`, `200`, `200`, `source=database`.

Додатково:

- `wrangler tail` → `trading cron processed`;
- admin desk → черги `Post-action reviews` і `Pending account overrides` порожні або
  містять лише очікувані запити;
- новий payout не створюється без проходження eligibility gate.

---

## 5. Release checklist

1. `npx tsc --noEmit`
2. `npm run build`
3. `npm run qa:smoke` на локальному production build
4. `npm run db:backup -- --out backups/pre-deploy-<date>`
5. `npx vercel --prod --yes`
6. Перевірити `/`, `/login`, `/admin/login`, `/api/stats`
7. `wrangler tail` — дочекатися одного cron-циклу
8. Оновити `docs/PFT-launch-qa.md` і `docs/PFT-stress-test-backlog.md`

---

## 6. Known operator actions

- [ ] Підтвердити Neon PITR retention у консолі (§3.3).
- [ ] Зробити перший production logical export із production `DATABASE_URL`.
- [ ] Додати щотижневий restore drill у календар.
- [ ] Після counsel — опублікувати legal-сторінки й оновити footer/checkout.
