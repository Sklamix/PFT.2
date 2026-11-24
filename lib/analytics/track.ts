'use client'

import type { AnalyticsEventName, AnalyticsProps } from './events'

const ENDPOINT = '/api/events'
const SESSION_KEY = 'pft:analytics-session'

/**
 * Anonymous per-tab id. `sessionStorage` (not `localStorage`) so it dies with
 * the tab; no cookie is written and nothing here identifies a person.
 */
function getSessionId(): string | undefined {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY)
    if (existing) return existing
    const next =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)
    window.sessionStorage.setItem(SESSION_KEY, next)
    return next
  } catch {
    return undefined
  }
}

/**
 * Fire-and-forget event reporter.
 *
 * Everything funnels through this one function so the transport (beacon today,
 * something else later) can change without touching a single call site. It never
 * throws and never returns a promise: analytics must not be able to break a click.
 */
export function trackEvent(name: AnalyticsEventName, props?: AnalyticsProps): void {
  if (typeof window === 'undefined') return

  try {
    const body = JSON.stringify({
      name,
      props,
      path: window.location.pathname,
      sessionId: getSessionId(),
    })
    const blob = new Blob([body], { type: 'application/json' })

    const sent = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, blob)
    if (sent) return

    void fetch(ENDPOINT, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    }).catch(() => {
      // Dropped event — acceptable, and deliberately silent.
    })
  } catch {
    // Never let a measurement failure surface to the trader.
  }
}
