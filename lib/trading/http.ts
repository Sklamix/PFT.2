import { after, NextResponse } from 'next/server'
import { notifyBookEvents } from '@/lib/email/trade-events'
import type { EngineResult } from './engine'
import type { BookPayload } from './types'
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
    scheduleNotifications(result.book)
    return NextResponse.json(body)
  }
  return NextResponse.json({ error: result.error, book: result.book ?? null }, { status: result.status })
}

function scheduleNotifications(book: BookPayload) {
  const hasFilledOrder = book.events.orderUpdates.some((event) => event.status === 'FILLED')
  if (!hasFilledOrder && book.events.closed.length === 0) return
  try {
    after(() => notifyBookEvents(book))
  } catch {
    // `after` is only available inside a request; never let notifications block trading.
    void notifyBookEvents(book)
  }
}

export function handleError(error: unknown) {
  if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
  console.error('[pft trading]', error)
  return NextResponse.json({ error: 'Trading engine unavailable' }, { status: 500 })
}
