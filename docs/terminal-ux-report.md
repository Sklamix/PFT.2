# Terminal UX fixes — report

## Що зроблено

| Пакет | Коміт | Файли | Статус |
|---|---|---|---|
| 1 | `beecd1d` | `components/terminal/TerminalHeader.tsx` | implemented |
| 2 | `5642570` | `lib/terminal/level-tone.ts`, `components/terminal/TradingChart.tsx`, `components/terminal/OrderPanel.tsx`, `components/terminal/PositionsTable.tsx` | implemented |
| 3 | `058905a` | `prisma/schema.prisma`, `prisma/sql/order-ticket-settings.sql`, `scripts/bootstrap-production.cjs`, settings plumbing, `components/settings/trading-panel.tsx`, `lib/stores/useOrderTicketStore.ts`, `components/terminal/TerminalWorkspace.tsx` | implemented |
| 4 | `7e3f307` | `components/terminal/TradingChart.tsx`, `components/terminal/OrderPanel.tsx` | implemented |
| 5 | `1b6d1de` | `components/terminal/TradingChart.tsx`, `components/terminal/PositionsTable.tsx`, `lib/stores/useTerminalBook.ts` | implemented |
| 6 | `e1f63aa` | `components/terminal/TerminalWorkspace.tsx` (cursor/CSS) | implemented |
| 7 | `e10c30e` | `components/dashboard/sidebar.tsx` | implemented |
| 8 | `aebe123` | `lib/stores/useNotifications.ts`, `components/terminal/NotificationCenter.tsx`, `components/terminal/TerminalHeader.tsx`, `components/terminal/TerminalWorkspace.tsx`, `components/terminal/OrderPanel.tsx`, `components/terminal/PositionsTable.tsx`, `lib/trading/engine.ts`, `lib/trading/types.ts`, `app/api/notifications/email/route.ts` | implemented |
| 9 | `4a6122e` | `prisma/schema.prisma`, `prisma/sql/active-account.sql`, `scripts/bootstrap-production.cjs`, `app/api/auth/me/route.ts`, `app/api/terminal/active-account/route.ts`, `components/terminal/TerminalWorkspace.tsx` | implemented |
| 10 | `a78bc21` | `prisma/schema.prisma`, `prisma/sql/order-status-cancelled.sql`, `scripts/bootstrap-production.cjs`, `lib/dashboard/billing.ts`, `app/api/dashboard/billing/orders/[id]/cancel/route.ts`, `app/api/dashboard/billing/orders/[id]/pay/route.ts`, `components/dashboard/billing-view.tsx`, `app/api/checkout/pending/route.ts`, `lib/admin/types.ts` | implemented |
| 11 | `3ea7846` | `components/terminal/PositionsTable.tsx`, `lib/rules/proximity.ts`, `lib/email/rule-proximity.ts`, `app/api/cron/trading/route.ts`, `scripts/rule-proximity.test.ts`, `package.json` | implemented |
| 12 | `62e43bc` | `lib/accounts/reset.ts`, `app/api/accounts/[id]/reset/route.ts`, `components/terminal/ResetAccountDialog.tsx` | implemented |

## Рішення, які я прийняв сам (з обґрунтуванням)

- **OrderStatus не містив CANCELLED** (док припускав інше). Додав значення адитивно через `ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED'` + поле схеми + allowlist-запис `order-status-cancelled.sql`. Це адитивна зміна без DROP/ALTER TYPE існуючих значень.
- **ResetAccountDialog копірайт (§11.3 п.3)** реалізовано в пакеті 12, а не в пакеті 9 — бо в пакеті 9 був пропущений; додано `discountValidUntil` у `ResetEligibility` і API.
- **Manual review для платних reset** (§11.2 п.2) реалізовано в `provisionReset`: якщо трейдер мав reset іншого продукту за останні 60 днів, створюється `actionReviewRequestData` (kind RESET).
- **Pay route** використовує self-fetch до `/api/checkout` для повторного використання/створення інвойсу без дублювання PENDING-рядка.
- **Centr сповіщень**: повідомлення з `useTerminalBook.notice` (крім account-breach) переносяться в історію і банер прибирається (`dismissNotice`).
- **Flash-ефект** рядка позиції при deep-link зі сповіщення реалізований через `ring-2` на 2 с.
- **test:ai-support** показав 92 pass / 0 fail / 0 cancelled (1 тест пропущено через відсутність DB-доступу), тоді як у документі зазначено 59/20/13 — можливо через наявність змінного середовища/БД. Код тестів не змінювався.

## Що НЕ зроблено і чому

- **Ручні сценарії §15 (8 пунктів)** не виконано — у середовищі немає браузера; результати не вигадую.
- **`test:ai-support` базовий baseline 59/20/13** не відтворено точно; бачу 92/0/0. Не "лагодив" тестів.
- **`AppealDialog`** видалено з банера breach (замінено на "Contact support" посилання) — файл залишено, але не використовується в TerminalWorkspace.
- **`Frown` swap** реалізовано через два елементи з `group-hover:hidden`/`hidden group-hover:block` без JS-стану, як вказано.

## Розбіжності правил (пакет 12)

| Правило §18.2 | Статус | Файл:рядок | Дія |
|---|---|---|---|
| Reset після breach зі знижкою 20% протягом 2 календарних днів | implemented | `lib/accounts/reset.ts:121-125` | без змін |
| Reset створює новий акаунт з Phase 1 | implemented | `lib/accounts/reset.ts:245-256` | без змін |
| Reset не відновлює стару історію/баланс | implemented | `lib/accounts/reset.ts:259` (`resetSourceAccountId`) | без змін |
| Reset не пропонується для frozen | implemented | `lib/accounts/reset.ts:90-92` | без змін |
| Доступний для активного основного акаунта і backup після активації | implemented | `lib/accounts/reset.ts:93` (status IN BREACHED*) | без змін |
| Ліміт 1 reset на продукт / 30 днів | implemented | `lib/accounts/reset.ts:102-112` | без змін |
| Недоступний для fraud/abuse | implemented | `lib/accounts/reset.ts:97-100` | без змін |
| Reset fee не повертається | implemented | (no refund path) | без змін |
| Кілька reset за короткий період → manual review | partial → fixed | `lib/accounts/reset.ts:276-291` | додано review для платних reset при reset іншого продукту за 60 днів |
| Зловживання reset для обходу правил | implemented | (abuse patterns) | без змін |

## Перевірки

- `npx tsc --noEmit` → OK (0 errors)
- `npm run lint` → 0 errors, 85 warnings (базово ~81)
- `npm run build` → Compiled successfully
- `npm run test:ai-support` → 92 pass / 0 fail / 0 cancelled (1 пропущено через БД)
- `npm run test:rule-proximity` → 4 pass / 0 fail
- Ручні сценарії → не виконано (немає браузера)

## Побічні знахідки (не виправляв)

- `lib/admin/repository.ts` використовує власний тип `OrderStatus` — синхронізовано зі схемою (додано CANCELLED).
- `app/api/checkout/pending/route.ts` `CheckoutOrderSummary` — синхронізовано (додано CANCELLED).
- `OrderStatus` у БД фактично не містив CANCELLED, хоча документ припускав інше — виправлено адитивною міграцією.
- `AppealDialog` залишається в репозиторії, але більше не використовується в TerminalWorkspace.
