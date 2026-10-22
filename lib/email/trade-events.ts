import { sendEmail } from '@/lib/email/resend'
import { prisma } from '@/lib/prisma'
import { formatUsd } from '@/lib/dashboard-data'
import type { BookPayload } from '@/lib/trading/types'
import type { CloseReason, TradeHistory } from '@/lib/types/terminal'

const CLOSE_LABEL: Record<CloseReason, string> = {
  TAKE_PROFIT: 'Take profit hit',
  STOP_LOSS: 'Stop loss hit',
  MANUAL: 'Position closed',
  LIQUIDATION_BREACH: 'Position liquidated',
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:9px 0;color:#8a97ad;border-bottom:1px solid #1f2937;">${escapeHtml(label)}</td><td style="padding:9px 0;text-align:right;color:#f4f7fb;border-bottom:1px solid #1f2937;font-family:Menlo,Consolas,monospace;">${escapeHtml(value)}</td></tr>`,
    )
    .join('')
  const text = `${title}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${footer}`

  return {
    subject: title,
    html: `<div style="background:#0b111d;color:#f4f7fb;padding:28px;font-family:Arial,sans-serif;">
      <div style="max-width:560px;margin:0 auto;background:#111a2a;border:1px solid #253147;border-radius:12px;padding:24px;">
        <p style="margin:0 0 4px;color:#10b981;font-size:11px;letter-spacing:2px;text-transform:uppercase;">PFT Terminal</p>
        <h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;">${escapeHtml(title)}</h1>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1f2937;font-size:13px;">${body}</table>
        <p style="margin:20px 0 0;color:#8a97ad;font-size:12px;line-height:1.6;">${escapeHtml(footer)}</p>
      </div>
    </div>`,
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

/**
 * Sends account notifications for fills and protective exits. The caller schedules this after
 * the HTTP response, so a slow email provider never blocks order execution.
 */
export async function notifyBookEvents(book: BookPayload) {
  const filled = book.events.orderUpdates.filter((event) => event.status === 'FILLED')
  const closed = book.events.closed
  if (filled.length === 0 && closed.length === 0) return

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
    ...filled.map((event) => orderEmail(event.message, book.account.id)),
    ...closed.map((trade) => tradeEmail(trade, book.account.id)),
  ]

  const results = await Promise.allSettled(
    messages.map((message) => sendEmail({ to: email!, ...message })),
  )
  for (const result of results) {
    if (result.status === 'rejected') console.error('[pft notifications] Email failed', result.reason)
  }
}
