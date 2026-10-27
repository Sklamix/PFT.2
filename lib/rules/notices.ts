import { appUrl } from '@/lib/email/account-credentials'
import { sendEmail } from '@/lib/email/resend'
import { prisma } from '@/lib/prisma'
import {
  NO_ACQUIRED_RIGHT,
  RULES_CHANGELOG,
  RULES_EFFECTIVE_DATE,
  RULES_VERSION,
  ruleChangesSince,
  type RuleChange,
} from '@/lib/rules/version'

/** A rules update is announced to every trader who holds an account. */
export async function announceRuleChanges(now = new Date()) {
  const users = await prisma.user.findMany({
    where: {
      accounts: { some: {} },
      OR: [{ rulesNotifiedVersion: null }, { rulesNotifiedVersion: { not: RULES_VERSION } }],
    },
    select: { id: true, email: true, name: true, rulesNotifiedVersion: true },
    take: 500,
  })

  let notified = 0
  for (const user of users) {
    const changes = user.rulesNotifiedVersion ? ruleChangesSince(user.rulesNotifiedVersion) : RULES_CHANGELOG
    const email = await sendEmail({
      to: user.email,
      subject: `Rules update · version ${RULES_VERSION}`,
      idempotencyKey: `rules-${RULES_VERSION}-${user.id}`,
      text: renderText(user.name, changes),
      html: renderHtml(user.name, changes),
    })

    if (email.status === 'FAILED') continue

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { rulesNotifiedVersion: RULES_VERSION },
      }),
      prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'RULES_NOTICE_SENT',
          reason: `Rules version ${RULES_VERSION} announced`,
          metadata: {
            userId: user.id,
            previousVersion: user.rulesNotifiedVersion,
            version: RULES_VERSION,
            changes: changes.map((change) => `${change.version} · ${change.kind}: ${change.summary}`),
            email: email.status,
            automated: true,
            at: now.toISOString(),
          },
        },
      }),
    ])
    notified += 1
  }

  return { version: RULES_VERSION, effectiveDate: RULES_EFFECTIVE_DATE, notified, scanned: users.length }
}

function link() {
  return `${appUrl()}/rules`
}

function renderText(name: string, changes: RuleChange[]) {
  return [
    `Hi ${name},`,
    '',
    `The PFT rules are now version ${RULES_VERSION} (effective ${RULES_EFFECTIVE_DATE}).`,
    '',
    'What changed:',
    ...(changes.length > 0
      ? changes.map((change) => `• [${change.kind === 'risk' ? 'Risk' : 'Commercial'}] ${change.summary}`)
      : ['• Clarifications only; no change to trading conditions.']),
    '',
    NO_ACQUIRED_RIGHT,
    '',
    `Full rules: ${link()}`,
    '',
    'PFT Risk',
  ].join('\n')
}

function renderHtml(name: string, changes: RuleChange[]) {
  const items = (changes.length > 0
    ? changes.map(
        (change) =>
          `<li><strong>${change.kind === 'risk' ? 'Risk' : 'Commercial'}:</strong> ${change.summary}</li>`,
      )
    : ['<li>Clarifications only; no change to trading conditions.</li>']
  ).join('')
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
      <p>Hi ${name},</p>
      <p>The PFT rules are now <strong>version ${RULES_VERSION}</strong> (effective ${RULES_EFFECTIVE_DATE}).</p>
      <p><strong>What changed:</strong></p>
      <ul>${items}</ul>
      <p>${NO_ACQUIRED_RIGHT}</p>
      <p><a href="${link()}">Full rules</a></p>
      <p>PFT Risk</p>
    </div>
  `
}
