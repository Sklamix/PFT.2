import { appUrl } from '@/lib/email/account-credentials'
import { sendEmail, type EmailResult } from '@/lib/email/resend'
import { escapeHtml, pftEmailShell } from '@/lib/email/pft-email'

export function setPasswordUrl(token: string) {
  return `${appUrl()}/set-password?token=${encodeURIComponent(token)}`
}

export function sendPasswordResetEmail(to: { email: string; name: string }, token: string): Promise<EmailResult> {
  const link = setPasswordUrl(token)
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
    html: pftEmailShell({
      tone: 'info',
      title: 'Reset your password',
      body: `<p style="margin:0;">Hi ${escapeHtml(to.name)}, use the button below to choose a new password for your PFT trader login. The link expires in 1 hour.</p>`,
      cta: { label: 'Choose a new password', url: link },
      footer: `If you did not request this, you can ignore this email.\n\nButton not working? Copy this link into your browser:\n${link}`,
    }),
  })
}
