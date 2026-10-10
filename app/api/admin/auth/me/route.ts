import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'

export async function GET() {
  const { session, error } = await requireStaff()
  if (error) return error
  return NextResponse.json({ user: session })
}
