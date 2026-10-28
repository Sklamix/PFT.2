import { randomBytes } from 'crypto'
import { NextResponse } from 'next/server'
import { hashPassword, requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const STAFF_ROLES = ['ADMIN', 'RISK_MANAGER'] as const
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 12

/**
 * Creates an administrator or risk manager. ADMIN only; every creation is
 * audited. The password is either supplied by the caller (≥12 chars) or
 * generated and returned once in the response.
 */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  try {
    const body = (await request.json().catch(() => null)) as {
      email?: unknown
      name?: unknown
      role?: unknown
      password?: unknown
    } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
    const role = typeof body?.role === 'string' ? body.role : ''
    const providedPassword = typeof body?.password === 'string' ? body.password : ''

    if (!EMAIL_PATTERN.test(email) || email.length > 254) return jsonError('Enter a valid email address.', 400)
    if (name.length < 2) return jsonError('Enter the staff member’s full name.', 400)
    if (!STAFF_ROLES.includes(role as (typeof STAFF_ROLES)[number])) {
      return jsonError('Role must be ADMIN or RISK_MANAGER.', 400)
    }
    if (providedPassword && providedPassword.length < MIN_PASSWORD_LENGTH) {
      return jsonError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 400)
    }
    if (!process.env.DATABASE_URL) return jsonError('Staff accounts require a configured database.', 503)

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (existing) return jsonError('A user with this email already exists.', 409)

    const password = providedPassword || randomBytes(16).toString('base64url')
    const user = await prisma.user.create({
      data: {
        email,
        name,
        role: role as 'ADMIN' | 'RISK_MANAGER',
        passwordHash: hashPassword(password),
        kycStatus: 'APPROVED',
        emailVerifiedAt: new Date(),
        profileCompletedAt: new Date(),
      },
      select: { id: true, email: true, name: true, role: true },
    })

    await prisma.auditLog.create({
      data: {
        actorId: session.sub,
        action: 'STAFF_CREATED',
        reason: `Created ${role === 'ADMIN' ? 'admin' : 'risk manager'} ${email}`,
        metadata: { createdUserId: user.id, role, email },
      },
    })

    return NextResponse.json(
      { user, ...(providedPassword ? {} : { generatedPassword: password }) },
      { status: 201 },
    )
  } catch (error) {
    return safeError(error)
  }
}
