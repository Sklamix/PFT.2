import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { revokeCertificate } from '@/lib/certificates/issue'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') return jsonError('Only an admin can revoke a certificate.', 403)

  try {
    const { publicId } = await params
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 4) return jsonError('A reason of at least 4 characters is required.', 400)

    const cert = await prisma.certificate.findUnique({ where: { publicId }, select: { id: true } })
    if (!cert) return jsonError('Certificate not found.', 404)

    const revoked = await revokeCertificate(publicId, session.sub, reason)
    if (!revoked) return jsonError('Certificate is already revoked.', 409)

    await prisma.auditLog.create({
      data: {
        actorId: session.sub,
        action: 'CERTIFICATE_REVOKED',
        reason,
        metadata: { certificateId: publicId },
      },
    })

    return NextResponse.json({ ok: true, publicId })
  } catch (err) {
    return safeError(err)
  }
}
