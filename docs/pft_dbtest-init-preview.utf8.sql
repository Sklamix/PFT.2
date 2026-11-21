
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TRADER', 'ADMIN', 'RISK_MANAGER', 'SUPPORT');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('IN_PROGRESS', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChallengeType" AS ENUM ('ONE_STEP', 'TWO_STEP', 'FUNDED');

-- CreateEnum
CREATE TYPE "AccountPhase" AS ENUM ('PHASE_1', 'PHASE_2', 'FUNDED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'FROZEN_STANDBY', 'BREACHED', 'PASSED', 'PASSED_PHASE_1', 'PASSED_PHASE_2', 'FUNDED', 'BREACHED_DAILY', 'BREACHED_MAX', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PendingTradeOrderStatus" AS ENUM ('PENDING', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PendingOrderType" AS ENUM ('LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('TAKE_PROFIT', 'STOP_LOSS', 'MANUAL', 'LIQUIDATION_BREACH');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'DISBURSED', 'REJECTED', 'MANUALLY_PAID');

-- CreateEnum
CREATE TYPE "WalletNetwork" AS ENUM ('USDT_TRC20', 'USDT_ERC20');

-- CreateEnum
CREATE TYPE "RiskEquityState" AS ENUM ('UNCLASSIFIED', 'EXCLUDED', 'SHADOW', 'ENFORCE');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SupportCategory" AS ENUM ('GENERAL', 'CHALLENGE', 'PAYOUT', 'KYC', 'ACCOUNT', 'TECHNICAL', 'RULES');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportSenderType" AS ENUM ('TRADER', 'STAFF', 'AI');

-- CreateEnum
CREATE TYPE "CommissionModel" AS ENUM ('PER_LOT', 'PER_DEAL', 'PERCENT_NOTIONAL');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TRADE_PNL', 'ENTRY_COMMISSION', 'EXIT_COMMISSION', 'SWAP', 'ADJUSTMENT', 'REVERSAL', 'RECONCILIATION', 'PAYOUT_RESERVE', 'PAYOUT_RELEASE');

-- CreateEnum
CREATE TYPE "FxReconciliationStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ComponentGroup" AS ENUM ('SCHEDULER', 'VERCEL', 'WORKER', 'MARKET_DATA', 'DATABASE', 'RISK_ENGINE', 'EMAIL');

-- CreateEnum
CREATE TYPE "ComponentKind" AS ENUM ('SCHEDULER', 'APP', 'WORKER', 'JOB', 'PROVIDER');

-- CreateEnum
CREATE TYPE "LivenessState" AS ENUM ('HEALTHY', 'STALE', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExecutionState" AS ENUM ('STARTED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('HEARTBEAT_STALE', 'PROCESS_FAILED', 'PROCESS_TIMED_OUT', 'MARKET_STALE', 'MARKET_CONNECTION_FAILED', 'DB_UNAVAILABLE', 'EMAIL_DOWN', 'BATCH_PARTIAL_FAILURE', 'PROVIDER_FALLBACK_BROKEN');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "IncidentEventKind" AS ENUM ('FAILURE', 'RECOVERY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordTokenHash" TEXT,
    "passwordTokenExpiresAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "nickname" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "phone" TEXT,
    "country" TEXT,
    "avatarUrl" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "profileCompletedAt" TIMESTAMP(3),
    "role" "Role" NOT NULL DEFAULT 'TRADER',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "kycSessionId" TEXT,
    "kycVerifiedAt" TIMESTAMP(3),
    "kycNote" TEXT,
    "kycUpdatedAt" TIMESTAMP(3),
    "challengeStatus" "ChallengeStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "favoriteSymbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "canConfirmPayouts" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginIp" TEXT,
    "lastDeviceHash" TEXT,
    "activeSessionId" TEXT,
    "riskFlaggedAt" TIMESTAMP(3),
    "riskFlagReason" TEXT,
    "rulesNotifiedVersion" TEXT,
    "declaredVpsCountry" TEXT,
    "vpsDeclaredAt" TIMESTAMP(3),
    "telegram" TEXT,
    "discord" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "legalName" TEXT,
    "certificateNameConsentAt" TIMESTAMP(3),
    "interfaceLanguage" TEXT NOT NULL DEFAULT 'en',
    "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    "numberFormat" TEXT NOT NULL DEFAULT '1,234.56',
    "displayCurrency" TEXT NOT NULL DEFAULT 'USD',
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "lastPasswordChangedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "archivedById" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT,
    "deviceHash" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLoginCode" (
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailLoginCode_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mt5Login" TEXT NOT NULL,
    "mt5Server" TEXT NOT NULL,
    "customName" TEXT,
    "planSize" INTEGER NOT NULL,
    "challengeType" "ChallengeType" NOT NULL,
    "phase" "AccountPhase" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "leverage" TEXT NOT NULL DEFAULT '1:100',
    "drawdownMode" TEXT NOT NULL DEFAULT 'trailing',
    "initialBalance" DECIMAL(14,2) NOT NULL,
    "dailyStartingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "dailyStartingEquity" DECIMAL(14,2) NOT NULL,
    "dailyStartedAt" TIMESTAMP(3),
    "currentBalance" DECIMAL(14,2) NOT NULL,
    "currentEquity" DECIMAL(14,2) NOT NULL,
    "dailyDrawdownPct" DECIMAL(6,3) NOT NULL,
    "maxDrawdownPct" DECIMAL(6,3) NOT NULL,
    "dailyDrawdownLimitPct" DECIMAL(6,3) NOT NULL,
    "maxDrawdownLimitPct" DECIMAL(6,3) NOT NULL,
    "profitPct" DECIMAL(8,3) NOT NULL,
    "tradingDaysCount" INTEGER NOT NULL DEFAULT 0,
    "profitSplitPct" INTEGER NOT NULL DEFAULT 80,
    "reservedPayoutAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "breachReason" TEXT,
    "frozenAt" TIMESTAMP(3),
    "lastTelemetryAt" TIMESTAMP(3),
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "equity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peakEquity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peakEquityDecimal" DECIMAL(18,2),
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "archivedById" TEXT,
    "riskReviewAt" TIMESTAMP(3),
    "riskReviewReason" TEXT,
    "payoutExecutionAt" TIMESTAMP(3),
    "maxDailyLoss" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "maxTrailingDrawdown" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "profitTarget" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "isFrozenBackup" BOOLEAN NOT NULL DEFAULT false,
    "backupForAccountId" TEXT,
    "resetSourceAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "riskEquityState" "RiskEquityState" NOT NULL DEFAULT 'UNCLASSIFIED',
    "riskEquityStateReason" TEXT,
    "riskEquityStateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEquityBaseline" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accountStatus" TEXT NOT NULL,
    "initialBalance" DECIMAL(14,2) NOT NULL,
    "startingBalance" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "peakEquity" DECIMAL(18,2) NOT NULL,
    "dailyStartingEquity" DECIMAL(18,2) NOT NULL,
    "dailyStartedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskEquityBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEquityShadowEvaluation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "baselineId" TEXT,
    "modelVersion" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balance" DECIMAL(18,2) NOT NULL,
    "equity" DECIMAL(18,2) NOT NULL,
    "riskEquity" DECIMAL(18,2) NOT NULL,
    "reservedAddBack" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAddBack" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "dailyStartingRiskEquity" DECIMAL(18,2),
    "dailyLoss" DECIMAL(18,2),
    "dailyLimit" DECIMAL(18,2),
    "trailingPeak" DECIMAL(18,2),
    "trailingFloor" DECIMAL(18,2),
    "trailingDrawdown" DECIMAL(18,2),
    "hypotheticalBreach" TEXT,
    "hypotheticalReason" TEXT,
    "existingStatus" TEXT,
    "existingBreachReason" TEXT,
    "comparison" TEXT,
    "dataQuality" JSONB,
    "skippedReason" TEXT,
    "inputHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskEquityShadowEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountBreachEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "timeSource" TEXT,
    "requiresManualReview" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "auditLogId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountBreachEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'cryptomus',
    "providerOrderId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "rulesVersion" TEXT,
    "rawPayload" JSONB,
    "paymentUrl" TEXT,
    "providerInvoiceId" TEXT,
    "invoiceEmailStatus" "EmailDeliveryStatus",
    "invoiceEmailSentAt" TIMESTAMP(3),
    "invoiceEmailError" TEXT,
    "provisionedAt" TIMESTAMP(3),
    "credentialsEmailStatus" "EmailDeliveryStatus",
    "credentialsEmailSentAt" TIMESTAMP(3),
    "credentialsEmailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lots" DECIMAL(10,2) NOT NULL,
    "side" "TradeSide" NOT NULL,
    "openPrice" DECIMAL(14,5) NOT NULL,
    "closePrice" DECIMAL(14,5),
    "openTime" TIMESTAMP(3) NOT NULL,
    "closeTime" TIMESTAMP(3),
    "profit" DECIMAL(12,2) NOT NULL,
    "swap" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "commission" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
    "markedForLiquidation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "tradingAccountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "sizeLots" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "currentPrice" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION,
    "takeProfit" DOUBLE PRECISION,
    "floatingPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "originalLots" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingLots" DOUBLE PRECISION,
    "closedLots" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "contractSizeSnapshot" DECIMAL(18,4),
    "quoteCurrencySnapshot" TEXT,
    "instrumentLeverage" INTEGER,
    "commissionPlanId" TEXT,
    "commissionModel" "CommissionModel",
    "entryRateSnapshot" DECIMAL(18,8),
    "exitRateSnapshot" DECIMAL(18,8),
    "minFeeSnapshot" DECIMAL(12,2),
    "maxFeeSnapshot" DECIMAL(12,2),
    "entryCommission" DECIMAL(18,2),
    "entryCommissionCurrency" TEXT,
    "allocatedEntryCommission" DECIMAL(18,2),
    "entryFxRate" DECIMAL(18,10),
    "entryFxTimestamp" TIMESTAMP(3),
    "commissionSource" TEXT,
    "valuationStatus" TEXT,
    "idempotencyKey" TEXT,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingTradeOrder" (
    "id" TEXT NOT NULL,
    "tradingAccountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "PendingOrderType" NOT NULL DEFAULT 'LIMIT',
    "sizeLots" DOUBLE PRECISION NOT NULL,
    "limitPrice" DOUBLE PRECISION NOT NULL,
    "stopPrice" DOUBLE PRECISION,
    "triggeredAt" TIMESTAMP(3),
    "stopLoss" DOUBLE PRECISION,
    "takeProfit" DOUBLE PRECISION,
    "status" "PendingTradeOrderStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "filledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "instrumentLeverage" INTEGER,
    "contractSizeSnapshot" DECIMAL(18,4),
    "quoteCurrencySnapshot" TEXT,

    CONSTRAINT "PendingTradeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeHistory" (
    "id" TEXT NOT NULL,
    "tradingAccountId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "sizeLots" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "exitPrice" DOUBLE PRECISION NOT NULL,
    "pnl" DOUBLE PRECISION NOT NULL,
    "originalPnl" DOUBLE PRECISION,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "closeReason" "CloseReason" NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionId" TEXT,
    "grossPnl" DOUBLE PRECISION,
    "entryCommission" DECIMAL(18,2),
    "exitCommission" DECIMAL(18,2),
    "totalCommission" DECIMAL(18,2),
    "netPnl" DECIMAL(18,2),
    "closedLots" DOUBLE PRECISION,
    "remainingLots" DOUBLE PRECISION,
    "fxRate" DECIMAL(18,10),
    "fxTimestamp" TIMESTAMP(3),
    "fxSource" TEXT,
    "fxStale" BOOLEAN DEFAULT false,
    "fxUnresolved" BOOLEAN DEFAULT false,
    "pnlBasis" TEXT,
    "valuationStatus" TEXT,
    "idempotencyKey" TEXT,
    "originalGrossPnl" DOUBLE PRECISION,
    "originalNetPnl" DECIMAL(18,2),
    "originalFxRate" DECIMAL(18,10),
    "originalFxSource" TEXT,
    "originalFxStale" BOOLEAN,
    "originalFxUnresolved" BOOLEAN,
    "voidedById" TEXT,
    "voidedByKind" TEXT,
    "voidSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "priceSource" TEXT,
    "priceTimestamp" TIMESTAMP(3),
    "priceStale" BOOLEAN,

    CONSTRAINT "TradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "screenshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "profitSplitPct" INTEGER NOT NULL DEFAULT 80,
    "walletAddress" TEXT NOT NULL,
    "network" "WalletNetwork" NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "balanceReserved" BOOLEAN NOT NULL DEFAULT false,
    "requestKey" TEXT,
    "providerBatchId" TEXT,
    "providerPayoutId" TEXT,
    "providerStatus" TEXT,
    "executionPolicy" TEXT,
    "executionState" TEXT,
    "executionKey" TEXT,
    "executionClaimedAt" TIMESTAMP(3),
    "executionClaimedBy" TEXT,
    "executionLeaseUntil" TIMESTAMP(3),
    "executionSnapshotHash" TEXT,
    "txHash" TEXT,
    "rejectReason" TEXT,
    "forfeitedAt" TIMESTAMP(3),
    "cancelSource" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "paidAmount" DECIMAL(12,2),
    "paidCurrency" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "transactionRef" TEXT,
    "paidById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutLegacyCutoverEvidence" (
    "payoutId" TEXT NOT NULL,
    "evidenceReference" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutLegacyCutoverEvidence_pkey" PRIMARY KEY ("payoutId")
);

-- CreateTable
CREATE TABLE "AccountAppeal" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'OPEN',
    "breachKind" TEXT,
    "breachReason" TEXT,
    "reason" TEXT NOT NULL,
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "accountId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminMessage" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" "SupportCategory" NOT NULL DEFAULT 'GENERAL',
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "SupportPriority" NOT NULL DEFAULT 'NORMAL',
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderType" "SupportSenderType" NOT NULL,
    "senderUserId" TEXT,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySync" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "lastSyncedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "inProgress" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetrySync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketQuote" (
    "symbol" TEXT NOT NULL,
    "mid" DECIMAL(18,9) NOT NULL DEFAULT 0,
    "bid" DECIMAL(18,9) NOT NULL,
    "ask" DECIMAL(18,9) NOT NULL,
    "spreadType" TEXT NOT NULL DEFAULT 'SYNTHETIC',
    "source" TEXT NOT NULL DEFAULT 'TWELVE_DATA',
    "providerTime" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketQuote_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "PayoutProof" (
    "id" TEXT NOT NULL,
    "traderName" TEXT NOT NULL,
    "countryCode" VARCHAR(2) NOT NULL,
    "accountSize" DECIMAL(14,2) NOT NULL,
    "payoutAmount" DECIMAL(14,2) NOT NULL,
    "payoutMethod" TEXT NOT NULL,
    "sourcePayoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingInstrument" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "terminalSymbol" TEXT,
    "avgSpread" DECIMAL(10,3) NOT NULL,
    "commissionPerLot" DECIMAL(10,2) NOT NULL,
    "commissionConfigured" BOOLEAN NOT NULL DEFAULT false,
    "zeroFeeApproved" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "contractSize" DECIMAL(18,4),
    "minLots" DECIMAL(10,4),
    "lotStep" DECIMAL(10,4),
    "maxLots" DECIMAL(10,4),
    "tickSize" DECIMAL(18,8),
    "quoteCurrency" TEXT,
    "profitCurrency" TEXT,
    "leverage" INTEGER,
    "conversionMode" TEXT,
    "specSource" TEXT,
    "specVerified" BOOLEAN DEFAULT false,
    "specVerification" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPlan" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "model" "CommissionModel" NOT NULL,
    "entryRate" DECIMAL(18,8) NOT NULL,
    "exitRate" DECIMAL(18,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "minFee" DECIMAL(12,2),
    "maxFee" DECIMAL(12,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "zeroFeeApproved" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLedgerBaseline" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "historyComplete" BOOLEAN NOT NULL DEFAULT false,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'BASELINED',
    "sourceReference" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountLedgerBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "positionId" TEXT,
    "executionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxReconciliation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "positionId" TEXT,
    "tradeHistoryId" TEXT,
    "quoteCurrency" TEXT NOT NULL,
    "amountQuote" DECIMAL(18,8) NOT NULL,
    "status" "FxReconciliationStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "reason" TEXT,
    "appliedAmountUsd" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "appliedRate" DECIMAL(18,10),
    "resolutionRate" DECIMAL(18,10),
    "ratePair" TEXT,
    "rateTimestamp" TIMESTAMP(3),
    "rateSource" TEXT,
    "resolutionVersion" INTEGER,
    "resolutionNote" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingSpreadSample" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "spread" DECIMAL(18,8) NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingSpreadSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicEvent" (
    "id" TEXT NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "isTradable" BOOLEAN NOT NULL DEFAULT true,
    "country" TEXT NOT NULL,
    "externalId" TEXT,
    "forecast" TEXT,
    "previous" TEXT,
    "actual" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMetrics" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "avgExecutionSpeedMs" INTEGER NOT NULL DEFAULT 28,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformStats" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "totalRewardsPaid" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "fundedTradersCount" INTEGER NOT NULL DEFAULT 0,
    "avgPayoutTimeHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "countriesServedCount" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengePricing" (
    "id" TEXT NOT NULL,
    "accountSize" INTEGER NOT NULL,
    "challengeType" TEXT NOT NULL DEFAULT '2-STEP',
    "dailyLossType" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengePricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "accountId" TEXT,
    "payoutId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'VERIFIED',
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "revokedById" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'GOLD',
    "symbol" TEXT DEFAULT 'ЁЯкР',
    "displayNameMode" TEXT NOT NULL DEFAULT 'PROFILE',
    "showAmount" BOOLEAN NOT NULL DEFAULT true,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldCandle" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
    "minute" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldCandle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemComponent" (
    "key" TEXT NOT NULL,
    "group" "ComponentGroup" NOT NULL,
    "kind" "ComponentKind" NOT NULL,
    "label" TEXT NOT NULL,
    "expectedMs" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SystemComponent_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemHeartbeat" (
    "componentKey" TEXT NOT NULL,
    "liveness" "LivenessState" NOT NULL DEFAULT 'UNKNOWN',
    "lastStartedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessfulAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "runId" TEXT,
    "lastError" TEXT,
    "lastErrorCount" INTEGER NOT NULL DEFAULT 0,
    "lastMeta" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("componentKey")
);

-- CreateTable
CREATE TABLE "SystemExecution" (
    "id" TEXT NOT NULL,
    "componentKey" TEXT NOT NULL,
    "scheduledSlotKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "state" "ExecutionState" NOT NULL DEFAULT 'STARTED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "SystemExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHealthIncident" (
    "id" TEXT NOT NULL,
    "incidentType" "IncidentType" NOT NULL,
    "componentKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOccurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "suppressedAt" TIMESTAMP(3),
    "suppressionReason" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "SystemHealthIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemIncidentWatermark" (
    "componentKey" TEXT NOT NULL,
    "incidentType" "IncidentType" NOT NULL,
    "lastResolvedOccurredAt" TIMESTAMP(3) NOT NULL,
    "lastResolvedOrderKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemIncidentWatermark_pkey" PRIMARY KEY ("componentKey","incidentType")
);

-- CreateTable
CREATE TABLE "SystemIncidentEvent" (
    "id" TEXT NOT NULL,
    "componentKey" TEXT NOT NULL,
    "incidentType" "IncidentType" NOT NULL,
    "eventKind" "IncidentEventKind" NOT NULL,
    "eventId" TEXT NOT NULL,
    "incidentId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemIncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_passwordTokenHash_key" ON "User"("passwordTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_kycSessionId_key" ON "User"("kycSessionId");

-- CreateIndex
CREATE INDEX "AccessEvent_userId_createdAt_idx" ON "AccessEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AccessEvent_deviceHash_createdAt_idx" ON "AccessEvent"("deviceHash", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccount_displayId_key" ON "TradingAccount"("displayId");

-- CreateIndex
CREATE INDEX "TradingAccount_status_idx" ON "TradingAccount"("status");

-- CreateIndex
CREATE INDEX "TradingAccount_riskEquityState_idx" ON "TradingAccount"("riskEquityState");

-- CreateIndex
CREATE INDEX "TradingAccount_mt5Login_idx" ON "TradingAccount"("mt5Login");

-- CreateIndex
CREATE INDEX "TradingAccount_userId_idx" ON "TradingAccount"("userId");

-- CreateIndex
CREATE INDEX "TradingAccount_backupForAccountId_idx" ON "TradingAccount"("backupForAccountId");

-- CreateIndex
CREATE INDEX "TradingAccount_archivedAt_idx" ON "TradingAccount"("archivedAt");

-- CreateIndex
CREATE INDEX "TradingAccount_riskReviewAt_idx" ON "TradingAccount"("riskReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "RiskEquityBaseline_accountId_key" ON "RiskEquityBaseline"("accountId");

-- CreateIndex
CREATE INDEX "RiskEquityBaseline_capturedAt_idx" ON "RiskEquityBaseline"("capturedAt");

-- CreateIndex
CREATE INDEX "RiskEquityShadowEvaluation_accountId_evaluatedAt_idx" ON "RiskEquityShadowEvaluation"("accountId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "RiskEquityShadowEvaluation_hypotheticalBreach_idx" ON "RiskEquityShadowEvaluation"("hypotheticalBreach");

-- CreateIndex
CREATE INDEX "RiskEquityShadowEvaluation_skippedReason_idx" ON "RiskEquityShadowEvaluation"("skippedReason");

-- CreateIndex
CREATE UNIQUE INDEX "RiskEquityShadowEvaluation_accountId_inputHash_key" ON "RiskEquityShadowEvaluation"("accountId", "inputHash");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBreachEvent_dedupeKey_key" ON "AccountBreachEvent"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBreachEvent_auditLogId_key" ON "AccountBreachEvent"("auditLogId");

-- CreateIndex
CREATE INDEX "AccountBreachEvent_accountId_occurredAt_idx" ON "AccountBreachEvent"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "AccountBreachEvent_accountId_detectedAt_idx" ON "AccountBreachEvent"("accountId", "detectedAt");

-- CreateIndex
CREATE INDEX "AccountBreachEvent_kind_idx" ON "AccountBreachEvent"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Order_providerOrderId_key" ON "Order"("providerOrderId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Trade_accountId_status_idx" ON "Trade"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_accountId_ticket_key" ON "Trade"("accountId", "ticket");

-- CreateIndex
CREATE INDEX "Position_tradingAccountId_status_idx" ON "Position"("tradingAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Position_tradingAccountId_idempotencyKey_key" ON "Position"("tradingAccountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PendingTradeOrder_tradingAccountId_status_createdAt_idx" ON "PendingTradeOrder"("tradingAccountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PendingTradeOrder_status_createdAt_idx" ON "PendingTradeOrder"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingTradeOrder_tradingAccountId_idempotencyKey_key" ON "PendingTradeOrder"("tradingAccountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TradeHistory_tradingAccountId_closedAt_idx" ON "TradeHistory"("tradingAccountId", "closedAt");

-- CreateIndex
CREATE INDEX "TradeHistory_positionId_idx" ON "TradeHistory"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeHistory_tradingAccountId_idempotencyKey_key" ON "TradeHistory"("tradingAccountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tradeId_key" ON "JournalEntry"("tradeId");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_updatedAt_idx" ON "JournalEntry"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_providerPayoutId_key" ON "Payout"("providerPayoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_executionKey_key" ON "Payout"("executionKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_transactionRef_key" ON "Payout"("transactionRef");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_userId_requestKey_key" ON "Payout"("userId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutLegacyCutoverEvidence_evidenceHash_key" ON "PayoutLegacyCutoverEvidence"("evidenceHash");

-- CreateIndex
CREATE INDEX "AccountAppeal_status_createdAt_idx" ON "AccountAppeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AccountAppeal_accountId_idx" ON "AccountAppeal"("accountId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminMessage_createdAt_idx" ON "AdminMessage"("createdAt");

-- CreateIndex
CREATE INDEX "AdminMessage_audience_idx" ON "AdminMessage"("audience");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_publicId_key" ON "SupportTicket"("publicId");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_idx" ON "SupportTicket"("userId");

-- CreateIndex
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX "SupportTicket_priority_idx" ON "SupportTicket"("priority");

-- CreateIndex
CREATE INDEX "SupportTicket_assignedToId_idx" ON "SupportTicket"("assignedToId");

-- CreateIndex
CREATE INDEX "SupportTicket_updatedAt_idx" ON "SupportTicket"("updatedAt");

-- CreateIndex
CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_ticketId_idempotencyKey_key" ON "SupportMessage"("ticketId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_receivedAt_idx" ON "WebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE INDEX "MarketQuote_providerTime_idx" ON "MarketQuote"("providerTime");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutProof_sourcePayoutId_key" ON "PayoutProof"("sourcePayoutId");

-- CreateIndex
CREATE INDEX "PayoutProof_createdAt_idx" ON "PayoutProof"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradingInstrument_symbol_key" ON "TradingInstrument"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "TradingInstrument_terminalSymbol_key" ON "TradingInstrument"("terminalSymbol");

-- CreateIndex
CREATE INDEX "TradingInstrument_isActive_category_idx" ON "TradingInstrument"("isActive", "category");

-- CreateIndex
CREATE INDEX "CommissionPlan_instrumentId_isActive_effectiveFrom_idx" ON "CommissionPlan"("instrumentId", "isActive", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AccountLedgerBaseline_accountId_capturedAt_idx" ON "AccountLedgerBaseline"("accountId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountLedgerBaseline_accountId_version_key" ON "AccountLedgerBaseline"("accountId", "version");

-- CreateIndex
CREATE INDEX "AccountLedgerEntry_accountId_createdAt_idx" ON "AccountLedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AccountLedgerEntry_type_createdAt_idx" ON "AccountLedgerEntry"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AccountLedgerEntry_positionId_idx" ON "AccountLedgerEntry"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountLedgerEntry_accountId_idempotencyKey_key" ON "AccountLedgerEntry"("accountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FxReconciliation_status_createdAt_idx" ON "FxReconciliation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FxReconciliation_accountId_idx" ON "FxReconciliation"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FxReconciliation_tradeHistoryId_key" ON "FxReconciliation"("tradeHistoryId");

-- CreateIndex
CREATE INDEX "TradingSpreadSample_instrumentId_sampledAt_idx" ON "TradingSpreadSample"("instrumentId", "sampledAt");

-- CreateIndex
CREATE INDEX "TradingSpreadSample_sampledAt_idx" ON "TradingSpreadSample"("sampledAt");

-- CreateIndex
CREATE UNIQUE INDEX "EconomicEvent_externalId_key" ON "EconomicEvent"("externalId");

-- CreateIndex
CREATE INDEX "EconomicEvent_time_idx" ON "EconomicEvent"("time");

-- CreateIndex
CREATE INDEX "EconomicEvent_impact_time_idx" ON "EconomicEvent"("impact", "time");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengePricing_accountSize_challengeType_dailyLossType_key" ON "ChallengePricing"("accountSize", "challengeType", "dailyLossType");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_publicId_key" ON "Certificate"("publicId");

-- CreateIndex
CREATE INDEX "Certificate_userId_idx" ON "Certificate"("userId");

-- CreateIndex
CREATE INDEX "Certificate_status_idx" ON "Certificate"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_userId_type_eventKey_key" ON "Certificate"("userId", "type", "eventKey");

-- CreateIndex
CREATE INDEX "GoldCandle_symbol_minute_idx" ON "GoldCandle"("symbol", "minute");

-- CreateIndex
CREATE UNIQUE INDEX "GoldCandle_symbol_minute_key" ON "GoldCandle"("symbol", "minute");

-- CreateIndex
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");

-- CreateIndex
CREATE INDEX "SystemExecution_componentKey_startedAt_idx" ON "SystemExecution"("componentKey", "startedAt");

-- CreateIndex
CREATE INDEX "SystemExecution_runId_idx" ON "SystemExecution"("runId");

-- CreateIndex
CREATE INDEX "SystemExecution_componentKey_state_finishedAt_scheduledSlot_idx" ON "SystemExecution"("componentKey", "state", "finishedAt", "scheduledSlotKey");

-- CreateIndex
CREATE INDEX "SystemExecution_componentKey_state_leaseExpiresAt_scheduled_idx" ON "SystemExecution"("componentKey", "state", "leaseExpiresAt", "scheduledSlotKey");

-- CreateIndex
CREATE UNIQUE INDEX "SystemExecution_componentKey_scheduledSlotKey_key" ON "SystemExecution"("componentKey", "scheduledSlotKey");

-- CreateIndex
CREATE UNIQUE INDEX "SystemHealthIncident_activeKey_key" ON "SystemHealthIncident"("activeKey");

-- CreateIndex
CREATE INDEX "SystemHealthIncident_componentKey_status_idx" ON "SystemHealthIncident"("componentKey", "status");

-- CreateIndex
CREATE INDEX "SystemHealthIncident_openedAt_idx" ON "SystemHealthIncident"("openedAt");

-- CreateIndex
CREATE INDEX "SystemIncidentEvent_componentKey_incidentType_processedAt_idx" ON "SystemIncidentEvent"("componentKey", "incidentType", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemIncidentEvent_componentKey_incidentType_eventKind_eve_key" ON "SystemIncidentEvent"("componentKey", "incidentType", "eventKind", "eventId");

-- AddForeignKey
ALTER TABLE "AccessEvent" ADD CONSTRAINT "AccessEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEquityBaseline" ADD CONSTRAINT "RiskEquityBaseline_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEquityShadowEvaluation" ADD CONSTRAINT "RiskEquityShadowEvaluation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEquityShadowEvaluation" ADD CONSTRAINT "RiskEquityShadowEvaluation_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "RiskEquityBaseline"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBreachEvent" ADD CONSTRAINT "AccountBreachEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBreachEvent" ADD CONSTRAINT "AccountBreachEvent_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "AuditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTradeOrder" ADD CONSTRAINT "PendingTradeOrder_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeHistory" ADD CONSTRAINT "TradeHistory_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "TradeHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutLegacyCutoverEvidence" ADD CONSTRAINT "PayoutLegacyCutoverEvidence_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAppeal" ADD CONSTRAINT "AccountAppeal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAppeal" ADD CONSTRAINT "AccountAppeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAppeal" ADD CONSTRAINT "AccountAppeal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlan" ADD CONSTRAINT "CommissionPlan_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "TradingInstrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLedgerBaseline" ADD CONSTRAINT "AccountLedgerBaseline_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLedgerEntry" ADD CONSTRAINT "AccountLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingSpreadSample" ADD CONSTRAINT "TradingSpreadSample_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "TradingInstrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemHeartbeat" ADD CONSTRAINT "SystemHeartbeat_componentKey_fkey" FOREIGN KEY ("componentKey") REFERENCES "SystemComponent"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemExecution" ADD CONSTRAINT "SystemExecution_componentKey_fkey" FOREIGN KEY ("componentKey") REFERENCES "SystemComponent"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemHealthIncident" ADD CONSTRAINT "SystemHealthIncident_componentKey_fkey" FOREIGN KEY ("componentKey") REFERENCES "SystemComponent"("key") ON DELETE CASCADE ON UPDATE CASCADE;

