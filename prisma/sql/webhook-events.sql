-- Durable webhook idempotency keys (hash of provider + raw signed payload).
CREATE TABLE IF NOT EXISTS "WebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebhookEvent_provider_receivedAt_idx"
  ON "WebhookEvent"("provider", "receivedAt");
