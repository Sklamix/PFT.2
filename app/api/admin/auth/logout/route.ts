import { NextResponse } from 'next/server'
import { clearSessionCookie } from '@/lib/admin/auth'

export async function POST() {
  return clearSessionCookie(NextResponse.json({ ok: true }))
}
