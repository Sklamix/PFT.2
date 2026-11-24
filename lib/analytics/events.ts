/**
 * Canonical list of first-party marketing events.
 *
 * Shared by the browser helper (`lib/analytics/track.ts`) and the ingest route
 * (`app/api/events/route.ts`) so the allowlist cannot drift between the two.
 * Adding an event means adding it here first — the route rejects anything else.
 */
export const ANALYTICS_EVENTS = [
  'hero_cta_click',
  'hero_login_click',
  'planet_focus',
  'planet_marker_open',
  'advantage_card_cta',
  'calculator_checkout_open',
  'proof_verify_click',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number]

export type AnalyticsProps = Record<string, string | number | boolean>

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && (ANALYTICS_EVENTS as readonly string[]).includes(value)
}
