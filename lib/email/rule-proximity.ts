import { sendEmail, type EmailResult } from './resend'
import { escapeHtml, emailRows, pftEmailShell } from './pft-email'
import { appUrl } from '@/lib/app-url'

type RuleProximityWarning = {
  to: string
  name: string
  displayId: string
  accountId?: string
  rule: 'daily' | 'trailing'
  used: number
  limit: number
  buffer: number
  ratio: number
}

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`

function ruleLabel(rule: 'daily' | 'trailing') {
  return rule === 'daily' ? 'Daily loss' : 'Trailing drawdown'
}

export async function sendRuleProximityWarning(input: RuleProximityWarning): Promise<EmailResult> {
  const tone = input.ratio >= 0.9 ? 'error' : 'pending'
  const date = new Date().toISOString().slice(0, 10)
  const url = `${appUrl()}/dashboard/terminal${input.accountId ? `?account=${encodeURIComponent(input.accountId)}` : ''}`

  const rows: [string, string][] = [
    ['Account', input.displayId],
    ['Rule', ruleLabel(input.rule)],
    ['Used', usd(input.used)],
    ['Limit', usd(input.limit)],
    ['Buffer left', usd(input.buffer)],
    ['Used %', `${Math.round(input.ratio * 100)}%`],
  ]

  const title = `Risk rule approaching limit · ${input.displayId}`

  return sendEmail({
    to: input.to,
    subject: title,
    idempotencyKey: `rule-proximity-${input.displayId}-${input.rule}-${date}`,
    text: [
      `Hi ${input.name},`,
      '',
      `Your ${ruleLabel(input.rule).toLowerCase()} rule on ${input.displayId} is at ${Math.round(input.ratio * 100)}% of its limit.`,
      '',
      ...rows.map(([label, value]) => `${label}: ${value}`),
      '',
      'Review your positions to avoid a breach.',
      '',
      `Open terminal: ${url}`,
    ].join('\n'),
    html: pftEmailShell({
      tone,
      title,
      body: `<p style="margin:0 0 14px;">Hi ${escapeHtml(input.name)}, your ${escapeHtml(ruleLabel(input.rule).toLowerCase())} rule on <strong style="color:#f1f5f9;">${escapeHtml(input.displayId)}</strong> is at <strong style="color:#f1f5f9;">${Math.round(input.ratio * 100)}%</strong> of its limit.</p>${emailRows(rows)}`,
      cta: { label: 'Open terminal', url },
      footer: 'PFT Risk',
    }),
  })
}
