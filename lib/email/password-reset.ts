import { appUrl } from '@/lib/email/account-credentials'
import { sendEmail, type EmailResult } from '@/lib/email/resend'

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function setPasswordUrl(token: string) {
  return `${appUrl()}/set-password?token=${encodeURIComponent(token)}`
}

export function sendPasswordResetEmail(to: { email: string; name: string }, token: string): Promise<EmailResult> {
  const link = setPasswordUrl(token)
  const url = escapeHtml(link)
  return sendEmail({
    to: to.email,
    subject: 'Reset your PFT trader password',
    text: [
      `Hi ${to.name},`,
      '',
      'Use this link to choose a new password for your PFT trader login. It expires in 1 hour:',
      link,
      '',
      'If you did not request this, you can ignore this email.',
    ].join('\n'),
    html: `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b0f17;font-family:Arial,Helvetica,sans-serif;color:#e5e7eb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#111827;border-radius:12px;">
      <tr><td style="padding:28px;">
        <h1 style="margin:0 0 12px;font-size:20px;color:#ffffff;">Reset your password</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;">Hi ${escapeHtml(to.name)}, use the button below to choose a new password for your PFT trader login. The link expires in 1 hour.</p>
        <p style="margin:0 0 20px;"><a href="${url}" style="display:inline-block;padding:12px 22px;background:#10b981;color:#04110b;text-decoration:none;font-weight:bold;border-radius:8px;">Choose a new password</a></p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">If you did not request this, you can ignore this email.<br>Link: <a href="${url}" style="color:#34d399;word-break:break-all;">${url}</a></p>
      </td></tr>
    </table>
  </body>
</html>`,
  })
}
