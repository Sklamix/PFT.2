import { NextResponse } from 'next/server'
import { clearTraderCookie } from '@/lib/trader/auth'

export async function POST() {
  return clearTraderCookie(NextResponse.json({ ok: true }))
}
