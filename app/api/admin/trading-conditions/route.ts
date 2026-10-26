import { NextResponse } from 'next/server'
import { requireAdmin, requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { getTradingConditionsForAdmin, updateTradingConditions } from '@/lib/market/conditions-service'
import type { TradingConditionUpdate } from '@/lib/market/conditions-types'

export const dynamic = 'force-dynamic'

function numberInRange(value: unknown, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export async function GET() {
  const { error } = await requireStaff()
  if (error) return error
  try {
    return NextResponse.json(await getTradingConditionsForAdmin())
  } catch (err) {
    return safeError(err)
  }
}

export async function PATCH(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError('Invalid JSON body')

  let avgExecutionSpeedMs: number | undefined
  if (body.avgExecutionSpeedMs != null) {
    const parsed = numberInRange(body.avgExecutionSpeedMs, 0, 10_000)
    if (parsed == null) return jsonError('Execution speed must be between 0 and 10000 ms')
    avgExecutionSpeedMs = parsed
  }

  const rawInstruments = Array.isArray(body.instruments) ? body.instruments : []
  const instruments: TradingConditionUpdate[] = []
  for (const raw of rawInstruments) {
    if (!raw || typeof raw !== 'object') return jsonError('Invalid instrument payload')
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    const avgSpread = numberInRange(row.avgSpread, 0, 10_000)
    const commissionPerLot = numberInRange(row.commissionPerLot, 0, 10_000)
    if (!id) return jsonError('Instrument id is required')
    if (avgSpread == null) return jsonError('Average spread must be a positive number or zero')
    if (commissionPerLot == null) return jsonError('Commission must be a positive number or zero')
    if (typeof row.isActive !== 'boolean') return jsonError('Instrument active flag must be a boolean')
    instruments.push({ id, avgSpread, commissionPerLot, isActive: row.isActive })
  }

  if (avgExecutionSpeedMs == null && instruments.length === 0) {
    return jsonError('Nothing to update')
  }

  try {
    const payload = await updateTradingConditions({ avgExecutionSpeedMs, instruments })
    return NextResponse.json(payload)
  } catch (err) {
    return safeError(err)
  }
}
