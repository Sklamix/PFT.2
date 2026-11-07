import { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { writeHeartbeat } from './observability'

/**
 * Observability heartbeat for the Railway trading-orders worker (Phase 1.7.9.2).
 *
 * Uses the existing Prisma `writeHeartbeat` (the worker runs on Node + Prisma, so
 * the Prisma-based observability module is safe to use). Only aggregate counters
 * and timestamps are stored — no account/order ids, financial data, or secrets.
 *
 * Liveness (`HEALTHY`) means only that the worker is alive and wrote a report, not
 * that every order was processed. Business state lives in `lastMeta`.
 */

export const TRADING_ORDERS_COMPONENT_KEY = 'railway:trading-orders'
export const TRADING_ORDERS_HEARTBEAT_INTERVAL_MS = 30_000

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'
export type ErrorCategory = 'connection' | 'database' | 'processing' | null

export type TradingOrdersHeartbeatState = {
  connectionState: ConnectionState
  connectedAt: string | null
  lastMessageAt: string | null
  lastProcessedAt: string | null
  reconnectCount: number
  processingSuccessCount: number
  processingErrorCount: number
  lastErrorCategory: ErrorCategory
}

export type TradingOrdersHeartbeatMeta = {
  connectionState: ConnectionState
  connectedAt: string | null
  lastMessageAt: string | null
  lastProcessedAt: string | null
  reconnectCount: number
  processingSuccessCount: number
  processingErrorCount: number
  lastErrorCategory: ErrorCategory
}

export function createTradingOrdersState(): TradingOrdersHeartbeatState {
  return {
    connectionState: 'connecting',
    connectedAt: null,
    lastMessageAt: null,
    lastProcessedAt: null,
    reconnectCount: 0,
    processingSuccessCount: 0,
    processingErrorCount: 0,
    lastErrorCategory: null,
  }
}

/** WebSocket `open` — transition to connected and clear the last error. */
export function recordConnection(state: TradingOrdersHeartbeatState, now = new Date()): void {
  state.connectionState = 'connected'
  state.connectedAt = now.toISOString()
  state.lastErrorCategory = null
}

/** WebSocket `close` of the current socket — transition to reconnecting. */
export function recordReconnect(state: TradingOrdersHeartbeatState): void {
  state.connectionState = 'reconnecting'
  state.reconnectCount += 1
  state.lastErrorCategory = 'connection'
}

/** WebSocket `error` — registers a connection error without changing state. */
export function recordConnectionError(state: TradingOrdersHeartbeatState): void {
  state.lastErrorCategory = 'connection'
}

/** Graceful shutdown — transition to stopped. */
export function recordStopped(state: TradingOrdersHeartbeatState): void {
  state.connectionState = 'stopped'
}

/** WebSocket `message` received (before parsing). */
export function recordMessage(state: TradingOrdersHeartbeatState, now = new Date()): void {
  state.lastMessageAt = now.toISOString()
}

/** `marketQuote.upsert` failure — a database (price write) error. */
export function recordPriceWriteError(state: TradingOrdersHeartbeatState): void {
  state.lastErrorCategory = 'database'
}

/** Successful `syncAccount` (`result.ok === true`). */
export function recordSyncSuccess(state: TradingOrdersHeartbeatState, now = new Date()): void {
  state.processingSuccessCount += 1
  state.lastProcessedAt = now.toISOString()
  state.lastErrorCategory = null
}

/** Failed `syncAccount` (`result.ok === false` or a thrown exception). */
export function recordSyncError(state: TradingOrdersHeartbeatState): void {
  state.processingErrorCount += 1
  state.lastErrorCategory = 'processing'
}

export function buildTradingOrdersHeartbeatMeta(
  state: TradingOrdersHeartbeatState,
): TradingOrdersHeartbeatMeta {
  return {
    connectionState: state.connectionState,
    connectedAt: state.connectedAt,
    lastMessageAt: state.lastMessageAt,
    lastProcessedAt: state.lastProcessedAt,
    reconnectCount: state.reconnectCount,
    processingSuccessCount: state.processingSuccessCount,
    processingErrorCount: state.processingErrorCount,
    lastErrorCategory: state.lastErrorCategory,
  }
}

/**
 * Writes one heartbeat row. `liveness` is always HEALTHY — it reflects that the
 * worker completed a heartbeat write, not that every order was processed.
 */
export async function heartbeatOnce(
  state: TradingOrdersHeartbeatState,
  db: PrismaClient = prisma,
): Promise<void> {
  await writeHeartbeat(
    {
      key: TRADING_ORDERS_COMPONENT_KEY,
      group: 'WORKER',
      kind: 'WORKER',
      label: 'Railway Trading Orders',
      expectedMs: TRADING_ORDERS_HEARTBEAT_INTERVAL_MS,
      liveness: 'HEALTHY',
      lastSuccessfulAt: new Date(),
      lastError: null,
      lastMeta: buildTradingOrdersHeartbeatMeta(state),
    },
    db,
  )
}
