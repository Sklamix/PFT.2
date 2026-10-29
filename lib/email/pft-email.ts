/**
 * Shared cosmic email shell for PFT system messages. All transactional emails
 * render through this so they share the same premium dark brand language.
 */

export type PFTEmailTone = 'success' | 'pending' | 'error' | 'info' | 'neutral'

const ACCENT: Record<PFTEmailTone, string> = {
  success: '#34d399',
  pending: '#f5b942',
  error: '#f87171',
  info: '#38bdf8',
  neutral: '#94a3b8',
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Two-column key/value table for account/order details. */
export function emailRows(rows: [string, string][]): string {
  if (rows.length === 0) return ''
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:10px 0;color:#94a3b8;border-bottom:1px solid #1f2937;">${escapeHtml(label)}</td><td style="padding:10px 0;text-align:right;color:#f1f5f9;border-bottom:1px solid #1f2937;font-family:Menlo,Consolas,monospace;font-size:13px;">${escapeHtml(value)}</td></tr>`,
    )
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-top:1px solid #1f2937;">${body}</table>`
}

type ShellOptions = {
  tone?: PFTEmailTone
  title: string
  /** Inner body HTML (paragraphs, rows, headings) — already built by the caller. */
  body: string
  cta?: { label: string; url: string }
  /** Plain-text footer; paragraphs separated by blank lines. */
  footer?: string
}

export function pftEmailShell({ tone = 'neutral', title, body, cta, footer }: ShellOptions): string {
  const accent = ACCENT[tone]
  const footerHtml = footer
    ? footer
        .split(/\n\n+/)
        .filter(Boolean)
        .map((paragraph) => `<p style="margin:0 0 8px;">${escapeHtml(paragraph)}</p>`)
        .join('')
    : ''
  const ctaHtml = cta
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:13px 26px;background:${accent};color:#04110b;text-decoration:none;font-weight:bold;border-radius:8px;font-size:14px;">${escapeHtml(cta.label)}</a></p>`
    : ''

  return `<!doctype html>
<html>
  <body style="margin:0;padding:28px 16px;background:#05070d;font-family:Arial,Helvetica,sans-serif;color:#e5e7eb;">
    <div style="max-width:560px;margin:0 auto;background:#0b0f19;border:1px solid #1f2937;border-radius:14px;overflow:hidden;">
      <div style="height:3px;background:linear-gradient(90deg,${accent},transparent);"></div>
      <div style="padding:28px 28px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
          <tr>
            <td style="padding-right:10px;">
              <span style="display:inline-block;border:1px solid ${accent};border-radius:6px;padding:4px 9px;font-family:Menlo,Consolas,monospace;font-size:11px;font-weight:bold;letter-spacing:2px;color:#ffffff;background:#080c14;">PFT</span>
            </td>
            <td style="vertical-align:middle;">
              <span style="font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:#64748b;">Professional Funded Trader</span>
            </td>
          </tr>
        </table>
        <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#ffffff;">${escapeHtml(title)}</h1>
        <div style="font-size:14px;line-height:1.6;color:#cbd5e1;">${body}</div>
        ${ctaHtml}
      </div>
      <div style="padding:20px 28px 28px;font-size:12px;line-height:1.6;color:#64748b;border-top:1px solid #1f2937;">
        ${footerHtml}
      </div>
    </div>
  </body>
</html>`
}
