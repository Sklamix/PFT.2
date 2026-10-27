const BERLIN = 'Europe/Berlin'
const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BERLIN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function parts(date: Date) {
  return Object.fromEntries(
    partsFormatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  ) as Record<string, string>
}

function offsetMs(date: Date) {
  const p = parts(date)
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  )
  return asUtc - date.getTime()
}

/** UTC instant of 00:00 in Europe/Berlin (CE(S)T). */
export function startOfBerlinDay(now = new Date()) {
  const p = parts(now)
  const localMidnightAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, 0, 0, 0)
  return new Date(localMidnightAsUtc - offsetMs(new Date(localMidnightAsUtc)))
}
