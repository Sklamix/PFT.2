import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'

function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || null
  return request.headers.get('x-real-ip')?.trim() || null
}

export async function recordAccessFingerprint(userId: string, request: Request) {
  if (!process.env.DATABASE_URL) return
  const userAgent = request.headers.get('user-agent')?.trim() || ''
  const lastDeviceHash = userAgent
    ? createHash('sha256').update(userAgent).digest('hex')
    : null
  const lastLoginIp = clientIp(request)
  if (!lastLoginIp && !lastDeviceHash) return

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { lastLoginIp, lastDeviceHash },
    })
  } catch (error) {
    console.warn('[pft access] fingerprint update failed', error)
  }
}
