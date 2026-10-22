# PFT market candle worker (Cloudflare)

Free scheduled worker that records live market ticks into the same Neon table used by the terminal
(`GoldCandle`, Prisma model `MarketCandle`).

- Cron: every minute (Cloudflare free plan)
- Each run collects FXCM FX/BTC quotes plus the Swissquote/gold-api XAU/USD spot four times,
  five seconds apart, and upserts one-minute candles.
- No Prisma, no long-running server: `@neondatabase/serverless` talks to Neon over HTTP.

## One-time setup

```bash
cd cloudflare/market-worker
npm install
npx wrangler login
npx wrangler secret put DATABASE_URL   # paste the production Neon connection string
npm run deploy
```

## Local check

```bash
# .dev.vars with DATABASE_URL=... (gitignored)
npx wrangler dev --test-scheduled
# then POST to /cdn-cgi/local/explorer/api/local/scheduled?worker=pft-market-worker
# body: {"cron":"* * * * *"}
```

## Verify

```sql
SELECT symbol, count(*), max(minute)
FROM "GoldCandle"
GROUP BY symbol
ORDER BY symbol;
```

Logs:

```bash
npx wrangler tail
```

Expected:

```
[pft market worker] stored EURUSD:... GBPUSD:... USDJPY:... BTCUSD:... XAUUSD:...
```

Cron runs once per minute and stores ~4 samples per symbol per minute. The terminal keeps writing
ticks while someone is using it; this worker fills the gaps when nobody is online.
