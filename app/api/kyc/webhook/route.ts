import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mapDiditStatus, verifyDiditWebhook } from '@/lib/kyc/didit'
import { setKycStatus } from '@/lib/kyc/state'
import { claimWebhookEvent, releaseWebhookEvent, webhookEventId } from '@/lib/security/webhook-events'

export const dynamic = 'force-dynamic'

type DiditWebhook = {
  webhook_type?: string
  session_id?: string
  status?: string
  vendor_data?: string
}

export async function POST(request: Request) {
  const secret = process.env.DIDIT_WEBHOOK_SECRET?.trim()
  if (!secret) {
    console.error('[pft kyc] DIDIT_WEBHOOK_SECRET is not configured')
    return NextResponse.json({ error: 'Webhook is not configured' }, { status: 503 })
  }

  const rawBody = await request.text()
  let payload: DiditWebhook
  try {
    payload = JSON.parse(rawBody) as DiditWebhook
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!verifyDiditWebhook(rawBody, payload, request.headers)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const eventId = webhookEventId('didit', rawBody)
  const claimed = await claimWebhookEvent(eventId, 'didit', payload.webhook_type || 'unknown')
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true })

  try {
    if (payload.webhook_type !== 'status.updated' && payload.webhook_type !== 'data.updated') {
      return NextResponse.json({ ok: true })
    }

    const sessionId = payload.session_id?.trim()
    const vendorId = payload.vendor_data?.trim()
    if (!sessionId && !vendorId) return NextResponse.json({ ok: true })

    const user = sessionId
      ? await prisma.user.findUnique({
          where: { kycSessionId: sessionId },
          select: { id: true, kycSessionId: true },
        })
      : vendorId
        ? await prisma.user.findUnique({
            where: { id: vendorId },
            select: { id: true, kycSessionId: true },
          })
        : null

    if (!user) return NextResponse.json({ ok: true })
    if (sessionId && user.kycSessionId && user.kycSessionId !== sessionId) return NextResponse.json({ ok: true })

    const mapped = mapDiditStatus(payload.status)
    if (!mapped) return NextResponse.json({ ok: true })

    await setKycStatus(user.id, mapped, {
      note: mapped === 'REJECTED' ? 'Declined by Didit' : mapped === 'NOT_STARTED' ? 'Didit session expired' : null,
      clearSession: mapped === 'NOT_STARTED',
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    await releaseWebhookEvent(eventId)
    console.error('[pft kyc] Webhook processing failed', error)
    return NextResponse.json({ error: 'Unable to process webhook' }, { status: 500 })
  }
}
