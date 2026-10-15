import { NextResponse } from 'next/server'
import type { EngineResult } from './engine'
import { ValidationError } from './validation'

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ValidationError('Request body must be valid JSON')
  }
}

export function respond<T extends object>(result: EngineResult<T>) {
  if (result.ok) {
    const { ok: _ok, ...body } = result
    return NextResponse.json(body)
  }
  return NextResponse.json({ error: result.error, book: result.book ?? null }, { status: result.status })
}

export function handleError(error: unknown) {
  if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
  console.error('[pft trading]', error)
  return NextResponse.json({ error: 'Trading engine unavailable' }, { status: 500 })
}
