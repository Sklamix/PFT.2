import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return jsonError('Unauthorized cron request', 401)
  }
  try {
    return NextResponse.json(await adminRepo.syncAll())
  } catch (err) {
    return safeError(err)
  }
}
