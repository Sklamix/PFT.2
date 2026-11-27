import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email/resend'
import { emailRows, pftEmailShell } from '@/lib/email/pft-email'
import { appUrl } from '@/lib/app-url'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { requireTrader } from '@/lib/trader/auth'

const MAX_NOTIFICATION_IDS = 20
const DIGEST_SUBJECT = 'Your PFT notifications'
const DIGEST_FOOTER = 'This digest was sent from the notifications of your Professional Funded Trader terminal.'

type DigestItem = { id: string; title: string; message: string }

export async function POST(request: Request) {
  try {
    const { session, error } = await requireTrader()
    if (error || !session) return error

    const body = await request.json().catch(() => null)
    const ids: unknown = body && typeof body === 'object' && 'ids' in body ? (body as { ids?: unknown }).ids : null
    const items: unknown = body && typeof body === 'object' && 'items' in body ? (body as { items?: unknown }).items : null
    const idList = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    const itemList: DigestItem[] = Array.isArray(items)
      ? items.filter(
          (item): item is DigestItem =>
            Boolean(item) && typeof item?.id === 'string' && typeof item?.title === 'string' && typeof item?.message === 'string',
        )
      : []

    if (idList.length < 1 || idList.length > MAX_NOTIFICATION_IDS) {
      return NextResponse.json({ error: 'Provide between 1 and 20 notification ids.' }, { status: 400 })
    }

    const uniqueIds = [...new Set(idList)]
    const digestKey = uniqueIds.slice().sort().join('-')

    if (await isRateLimited(`notify-email:${session.sub}`, 3, 60 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many emails. Try again in a few minutes.', retryAfterMs: 60 * 60_000 },
        { status: 429 },
      )
    }
    if (await isRateLimited(`notify-email-min:${session.sub}`, 1, 60_000)) {
      return NextResponse.json(
        { error: 'Too many emails. Try again in a few minutes.', retryAfterMs: 60_000 },
        { status: 429 },
      )
    }

    const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { email: true } })
    if (!user?.email) {
      return NextResponse.json({ error: 'Unable to resolve the notification email address.' }, { status: 503 })
    }

    const rows: [string, string][] = itemList.length > 0 ? itemList.map((item) => [item.title, item.message]) : [['Notification', uniqueIds.join(', ')]]
    const text = [`${DIGEST_SUBJECT}`, '', ...rows.map(([label, value]) => `${label}: ${value}`), '', DIGEST_FOOTER].join('\n')
    const result = await sendEmail({
      to: user.email,
      subject: DIGEST_SUBJECT,
      html: pftEmailShell({
        tone: 'info',
        title: DIGEST_SUBJECT,
        body: emailRows(rows),
        cta: { label: 'Open terminal', url: `${appUrl()}/dashboard/terminal` },
        footer: DIGEST_FOOTER,
      }),
      text,
      idempotencyKey: `notify-digest-${session.sub}-${digestKey}`,
    })

    if (result.status !== 'SENT') {
      return NextResponse.json({ error: 'Unable to send the notifications email right now.' }, { status: 503 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[pft notifications] Digest email failed', error)
    return NextResponse.json({ error: 'Unable to send the notifications email right now.' }, { status: 500 })
  }
}
