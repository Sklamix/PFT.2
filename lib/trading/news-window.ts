/**
 * News-window exposure classification.
 *
 * The actual breach time depends on how the position interacted with the event window:
 * - opened inside ±5 minutes: violation happens at `openedAt`;
 * - existed before and stayed open through the event: violation happens at `eventTime`;
 * - opened more than an hour earlier and still open: warning only.
 */
export type NewsExposureClass =
  | {
      kind: 'violation' | 'warning'
      occurredAt: Date
      occurredAtSource: 'POSITION_OPENED' | 'NEWS_EVENT' | 'UNKNOWN'
    }
  | null

export function classifyNewsExposure(input: {
  openedAt: Date
  closedAt: Date
  eventTime: Date
}): NewsExposureClass {
  const opener = input.openedAt.getTime()
  const closed = input.closedAt.getTime()
  const eventTime = input.eventTime.getTime()
  const delta = eventTime - opener

  if (delta >= -5 * 60_000 && delta <= 5 * 60_000) {
    return {
      kind: 'violation',
      occurredAt: input.openedAt,
      occurredAtSource: 'POSITION_OPENED',
    }
  }
  if (delta > 5 * 60_000 && delta <= 60 * 60_000 && closed >= eventTime) {
    return {
      kind: 'violation',
      occurredAt: input.eventTime,
      occurredAtSource: 'NEWS_EVENT',
    }
  }
  if (delta > 60 * 60_000 && closed >= eventTime) {
    return {
      kind: 'warning',
      occurredAt: input.eventTime,
      occurredAtSource: 'UNKNOWN',
    }
  }
  return null
}
