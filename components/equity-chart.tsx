const WIDTH = 640
const HEIGHT = 240
const POINTS = 48
const START = 100_000

function seededSeries() {
  let seed = 7
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
  const values: number[] = [START]
  for (let index = 1; index < POINTS; index++) {
    const drift = 60
    const shock = (random() - 0.45) * 1400
    values.push(values[index - 1] + drift + shock)
  }
  return values
}

const SERIES = seededSeries()
const MIN = Math.min(...SERIES) - 800
const MAX = Math.max(...SERIES) + 800

const toX = (index: number) => (index / (POINTS - 1)) * WIDTH
const toY = (value: number) => ((MAX - value) / (MAX - MIN)) * HEIGHT

const LINE = SERIES.map((value, index) => `${index === 0 ? 'M' : 'L'}${toX(index).toFixed(1)},${toY(value).toFixed(1)}`).join(' ')
const AREA = `${LINE} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`

export const EQUITY_LATEST = SERIES[SERIES.length - 1]
export const EQUITY_START = START

export function EquityChart() {
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="h-48 w-full sm:h-56"
      role="img"
      aria-label={`Equity curve rising from $100,000 to $${Math.round(EQUITY_LATEST).toLocaleString('en-US')}`}
    >
      <defs>
        <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="equity-stroke" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="var(--highlight)" />
          <stop offset="100%" stopColor="var(--primary)" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line key={ratio} x1="0" x2={WIDTH} y1={HEIGHT * ratio} y2={HEIGHT * ratio} stroke="var(--border)" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
      ))}
      <line x1="0" x2={WIDTH} y1={toY(START)} y2={toY(START)} stroke="var(--muted-foreground)" strokeOpacity="0.5" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      <path d={AREA} fill="url(#equity-fill)" />
      <path d={LINE} fill="none" stroke="url(#equity-stroke)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
