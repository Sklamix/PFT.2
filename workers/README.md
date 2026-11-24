# Twelve Data pricing and trading worker

The Railway worker subscribes to Twelve Data's WebSocket price stream for
EUR/USD, GBP/USD, and USD/JPY. It persists the provider's live price and
evaluates active trading accounts using that price.

## Railway setup

1. Create a Railway service from this repository with the repository root as
   the build context and `workers/Dockerfile` as the Dockerfile path.
2. Set `DATABASE_URL` to the same Neon PostgreSQL database used by the web app.
3. Set `TWELVE_DATA_API_KEY` to a private API key with WebSocket access and
   real-time Forex coverage for the three configured pairs.
4. Keep the service at one replica. Multiple replicas would duplicate stream
   connections, quote writes, and account evaluations.
5. Deploy and confirm the logs show a successful connection and subscription.

Keep `TWELVE_DATA_API_KEY` private in Railway; never expose it as a
`NEXT_PUBLIC_` variable. Run `npm run db:push` once to update the additive
`MarketQuote` table before deploying the worker and web app.

Twelve Data's stream sends prices (not executable bid/ask depth). The worker
stores the provider price as `mid` and calculates indicative bid/ask with the
platform's configured typical spread (`spreadType: SYNTHETIC`). This is not
broker Level-1. Account books are evaluated at most four times per second, with
up to ten accounts processed concurrently. The terminal reads the latest
server-stored prices through the authenticated `/api/trading/quotes` endpoint,
polling it every 250ms while visible.

Verify that the Twelve Data plan provides real-time Forex WebSocket access and
permits redisplaying the feed to your users before production use.

## Price alerts

The market worker also evaluates chart price alerts every 30 seconds
(`lib/alerts/evaluate.ts`, called from `workers/market-candles.ts`).

This is deliberate: Vercel's Hobby plan only allows daily cron jobs, and a daily
price alert is worthless. The worker already ticks every few seconds with the
database open, so it is the cheapest place to run the check.

Consequences for operations:

- If this worker is down, alerts stop firing — same failure mode as candles and
  quotes. Nothing else in the terminal depends on it for correctness.
- Keep it at one replica. Two replicas are safe for data (both claims are
  atomic), but they would duplicate provider traffic.
- `/api/alerts/check` still exists as a manual trigger, protected by
  `CRON_SECRET` or an admin session. Use it to force a run after fixing a
  mailer, not on a schedule.

