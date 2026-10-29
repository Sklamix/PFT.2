import { sendEmail } from '@/lib/email/resend'
import { prisma } from '@/lib/prisma'
import { emailRows, pftEmailShell } from '@/lib/email/pft-email'
import { formatUsd } from '@/lib/dashboard-data'
import type { BookPayload, NewsViolationEvent } from '@/lib/trading/types'
import type { CloseReason, TradeHistory } from '@/lib/types/terminal'

const CLOSE_LABEL: Record<CloseReason, string> = {
  TAKE_PROFIT: 'Take profit hit',
  STOP_LOSS: 'Stop loss hit',
  MANUAL: 'Position closed',
  LIQUIDATION_BREACH: 'Position liquidated',
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)
}

function emailShell(title: string, rows: [string, string][], footer: string) {
  const text = `${title}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${footer}`
  return {
    subject: title,
    html: pftEmailShell({ tone: 'neutral', title, body: emailRows(rows), footer }),
    text,
  }
}

function tradeEmail(trade: TradeHistory, accountId: string) {
  const title = `${CLOSE_LABEL[trade.closeReason]} · ${trade.symbol}`
  const { subject, html, text } = emailShell(
    title,
    [
      ['Account', accountId],
      ['Symbol', trade.symbol],
      ['Side', trade.side],
      ['Volume', `${trade.sizeLots.toFixed(2)} lots`],
      ['Entry', trade.entryPrice.toFixed(5)],
      ['Exit', trade.exitPrice.toFixed(5)],
      ['P&L', formatUsd(trade.pnl, { signed: true })],
      ['Closed', formatTime(trade.closedAt)],
    ],
    'This notification was sent because you have an active PFT trading account.',
  )
  return { subject, html, text }
}

function orderEmail(message: string, accountId: string) {
  const title = `Order filled · ${accountId}`
  const { subject, html, text } = emailShell(
    title,
    [
      ['Account', accountId],
      ['Order', message],
      ['Time', formatTime(new Date())],
    ],
    'This notification was sent because you have an active PFT trading account.',
  )
  return { subject, html, text }
}

function newsViolationEmail(event: NewsViolationEvent, accountId: string) {
  const title =
    event.kind === 'violation'
      ? `News-window violation · ${accountId}`
      : `News risk warning · ${accountId}`
  const rows: [string, string][] = [
    ['Account', accountId],
    ['Event', event.eventTitle],
    ['Event time', formatTime(new Date(event.eventTime))],
    ['Position', event.symbol],
    ['Result', event.kind === 'violation' ? 'Rule violation recorded' : 'Risk warning only'],
  ]
  if (event.kind === 'violation') {
    rows.push(['Profit annulled', formatUsd(event.annulledPnl, { signed: true })])
    rows.push(['Violation number', String(event.violationNumber ?? 1)])
  }
  const { subject, html, text } = emailShell(
    title,
    rows,
    event.kind === 'violation'
      ? 'Only the profit from the specific violating trade was annulled. Other trades and your account balance are unaffected.'
      : 'The position was opened well before the event; this is a risk warning, not a rule violation.',
  )
  return { subject, html, text }
}

/**
 * Sends account notifications for fills and protective exits. The caller schedules this after
 * the HTTP response, so a slow email provider never blocks order execution.
 */
export async function notifyBookEvents(book: BookPayload) {
  const filled = book.events.orderUpdates.filter((event) => event.status === 'FILLED')
  const closed = book.events.closed
  const newsViolations = book.events.newsViolations
  if (filled.length === 0 && closed.length === 0 && newsViolations.length === 0) return

  let email: string | null = null
  try {
    const user = await prisma.user.findUnique({ where: { id: book.account.userId }, select: { email: true } })
    email = user?.email ?? null
  } catch (error) {
    console.error('[pft notifications] Could not resolve trader email', error)
    return
  }
  if (!email) return

  const messages = [
    ...filled.map((event) => orderEmail(event.message, book.account.displayId)),
    ...closed.map((trade) => tradeEmail(trade, book.account.displayId)),
    ...newsViolations.map((event) => newsViolationEmail(event, book.account.displayId)),
  ]

  const results = await Promise.allSettled(
    messages.map((message) => sendEmail({ to: email!, ...message })),
  )
  for (const result of results) {
    if (result.status === 'rejected') console.error('[pft notifications] Email failed', result.reason)
  }
}
