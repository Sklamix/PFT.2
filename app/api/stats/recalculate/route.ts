import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { recalculatePlatformStats } from '@/lib/stats/public-stats'
import { safeSecretEqual } from '@/lib/security/secret-compare'

export const dynamic = 'force-dynamic'

async function authorized(request: Request) {
  const secret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization')
  if (secret && authorization && safeSecretEqual(authorization, `Bearer ${secret}`)) return true

  const { error } = await requireAdmin()
  return !error
}

async function run(request: Request) {
  if (!(await authorized(request))) return jsonError('Unauthorized stats recalculation', 401)
  try {
    return NextResponse.json(await recalculatePlatformStats())
  } catch (error) {
    return safeError(error)
  }
}

export async function GET(request: Request) {
  return run(request)
}

export async function POST(request: Request) {
  return run(request)
}
