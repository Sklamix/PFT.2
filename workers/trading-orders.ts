import { FOREX_MAJORS, spreadFromMid } from '@/lib/constants/symbols'
import {
  parseTwelveDataPriceMessage,
  twelveDataStreamUrl,
  twelveDataSubscriptionMessage,
  type TwelveDataPrice,
} from '@/lib/market/twelve-data'
import { prisma } from '@/lib/prisma'
import { syncAccount } from '@/lib/trading/engine'
import { tradingRepo } from '@/lib/trading/repository'
import type { Quotes } from '@/lib/trading/types'

const TARGET_REFRESH_MS = 5_000
const MIN_ACCOUNT_SYNC_INTERVAL_MS = 250
const MAX_CONCURRENT_ACCOUNT_SYNCS = 10
const ACCOUNT_SYNC_RETRY_MS = 100
const MAX_RECONNECT_DELAY_MS = 30_000

type Target = { accountId: string; symbol: string }
type AccountQueue = {
  quotes: Quotes
  running: boolean
  timer?: ReturnType<typeof setTimeout>
  lastRunAt: number
}

const targetSets = new Map<string, Set<string>>()
const accountQueues = new Map<string, AccountQueue>()
const activeSyncs = new Set<Promise<void>>()
const quoteTails = new Map<string, Promise<void>>()

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let targetRefreshTimer: ReturnType<typeof setInterval> | undefined
let reconnectDelay = 1_000
let stopping = false

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required to run the trading worker`)
  return value
}

function setTargets(targets: Target[]) {
  targetSets.clear()
  for (const { accountId, symbol } of targets) {
    if (!FOREX_MAJORS.includes(symbol as (typeof FOREX_MAJORS)[number])) continue
    const accountIds = targetSets.get(symbol) ?? new Set<string>()
    accountIds.add(accountId)
    targetSets.set(symbol, accountIds)
  }
}

async function refreshTargets() {
  try {
    setTargets(await tradingRepo.activeTradingTargets())
  } catch (error) {
    console.error('[pft trading worker] Failed to refresh active account symbols', error)
  }
}

function scheduleAccountSync(accountId: string, queue: AccountQueue) {
  if (stopping || queue.running || queue.timer || Object.keys(queue.quotes).length === 0) return
  const delay = Math.max(0, queue.lastRunAt + MIN_ACCOUNT_SYNC_INTERVAL_MS - Date.now())
  queue.timer = setTimeout(() => {
    queue.timer = undefined
    if (stopping) return
    if (activeSyncs.size >= MAX_CONCURRENT_ACCOUNT_SYNCS) {
      queue.timer = setTimeout(() => {
        queue.timer = undefined
        scheduleAccountSync(accountId, queue)
      }, ACCOUNT_SYNC_RETRY_MS)
      return
    }
    const task = drainAccountQueue(accountId, queue)
    activeSyncs.add(task)
    void task.finally(() => activeSyncs.delete(task))
  }, delay)
}

async function drainAccountQueue(accountId: string, queue: AccountQueue) {
  if (stopping || queue.running) return
  const quotes = queue.quotes
  queue.quotes = {}
  if (Object.keys(quotes).length === 0) return

  queue.running = true
  try {
    const result = await syncAccount(accountId, quotes)
    if (!result.ok) {
      console.error(`[pft trading worker] Account ${accountId} sync failed: ${result.error}`)
    } else if (result.book.events.orderUpdates.length > 0 || result.book.events.breach) {
      console.info('[pft trading worker] Account event', {
        accountId,
        orderUpdates: result.book.events.orderUpdates,
        breach: result.book.events.breach,
      })
    }
  } catch (error) {
    console.error(`[pft trading worker] Account ${accountId} sync failed`, error)
  } finally {
    queue.lastRunAt = Date.now()
    queue.running = false
    if (Object.keys(queue.quotes).length > 0) scheduleAccountSync(accountId, queue)
    else accountQueues.delete(accountId)
  }
}

function enqueueQuote(accountId: string, symbol: string, quote: { bid: number; ask: number }) {
  const queue = accountQueues.get(accountId) ?? {
    quotes: {},
    running: false,
    lastRunAt: 0,
  }
  queue.quotes[symbol] = quote
  accountQueues.set(accountId, queue)
  scheduleAccountSync(accountId, queue)
}

function persistPrice(price: TwelveDataPrice) {
  const quote = spreadFromMid(price.symbol, price.price)
  const previous = quoteTails.get(price.symbol) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(async () => {
    try {
      await prisma.marketQuote.upsert({
        where: { symbol: price.symbol },
        create: {
          symbol: price.symbol,
          mid: price.price,
          bid: quote.bid,
          ask: quote.ask,
          spreadType: 'SYNTHETIC',
          source: 'TWELVE_DATA',
          providerTime: price.providerTime,
        },
        update: {
          mid: price.price,
          bid: quote.bid,
          ask: quote.ask,
          spreadType: 'SYNTHETIC',
          source: 'TWELVE_DATA',
          providerTime: price.providerTime,
        },
      })
    } catch (error) {
      console.error(`[pft trading worker] Failed to persist ${price.symbol} price`, error)
      return
    }

    for (const accountId of targetSets.get(price.symbol) ?? []) {
      enqueueQuote(accountId, price.symbol, { bid: quote.bid, ask: quote.ask })
    }
  })
  quoteTails.set(price.symbol, task)
  void task.then(() => {
    if (quoteTails.get(price.symbol) === task) quoteTails.delete(price.symbol)
  })
}

function handleMessage(raw: string) {
  try {
    const price = parseTwelveDataPriceMessage(raw)
    if (price) persistPrice(price)
  } catch (error) {
    console.error('[pft trading worker] Twelve Data message error', error)
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return
  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    connect()
  }, delay)
}

function connect() {
  if (stopping) return
  const apiKey = requiredEnvironment('TWELVE_DATA_API_KEY')
  let current: WebSocket
  try {
    current = new WebSocket(twelveDataStreamUrl(apiKey))
  } catch (error) {
    console.error('[pft trading worker] Failed to create Twelve Data WebSocket', error)
    scheduleReconnect()
    return
  }
  socket = current

  current.addEventListener('open', () => {
    if (socket !== current || stopping) return
    reconnectDelay = 1_000
    current.send(twelveDataSubscriptionMessage(FOREX_MAJORS))
    console.info('[pft trading worker] Connected to Twelve Data price stream', {
      symbols: FOREX_MAJORS.join(','),
    })
  })
  current.addEventListener('message', (event) => {
    if (socket === current && !stopping) handleMessage(String(event.data))
  })
  current.addEventListener('error', (event) => {
    console.error('[pft trading worker] Twelve Data WebSocket error', event)
  })
  current.addEventListener('close', (event) => {
    if (socket !== current) return
    socket = null
    if (stopping) return
    console.warn('[pft trading worker] Twelve Data disconnected', {
      code: event.code,
      reason: event.reason,
    })
    scheduleReconnect()
  })
}

async function start() {
  requiredEnvironment('DATABASE_URL')
  requiredEnvironment('TWELVE_DATA_API_KEY')

  await refreshTargets()
  targetRefreshTimer = setInterval(() => void refreshTargets(), TARGET_REFRESH_MS)
  connect()
  console.info('[pft trading worker] Started')
}

async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.info(`[pft trading worker] Shutting down (${signal})`)
  if (targetRefreshTimer) clearInterval(targetRefreshTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  for (const queue of accountQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer)
  }
  socket?.close()
  await Promise.allSettled([...activeSyncs, ...quoteTails.values()])
  await prisma.$disconnect()
}

process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

void start().catch((error) => {
  console.error('[pft trading worker] Startup failed', error)
  process.exitCode = 1
  void prisma.$disconnect()
})
