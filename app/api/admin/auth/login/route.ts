import { NextResponse } from 'next/server'
import { applySessionCookie, signSession, verifyPassword } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import type { Role } from '@/lib/admin/types'

export async function POST(request: Request) {
  try {
    const { email, password } = (await request.json()) as { email?: string; password?: string }
    if (!email || !password) return jsonError('Email and password are required')

    const user = await adminRepo.findStaffByEmail(email)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return jsonError('Invalid credentials', 401)
    }
    if (user.role === 'TRADER') return jsonError('Staff role required', 403)

    const token = signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Exclude<Role, 'TRADER'>,
    })
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
    return applySessionCookie(response, token)
  } catch (error) {
    return safeError(error)
  }
}
