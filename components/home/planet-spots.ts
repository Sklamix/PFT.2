export type PlanetSpotId = 'challenges' | 'rules' | 'payouts' | 'platforms' | 'faq'
export type PlanetMode = 'hero' | 'focus' | 'detail'

export type PlanetSpot = {
  id: PlanetSpotId
  label: string
  heading: string
  body: string
  ctaLabel: string
  href: `#${PlanetSpotId}`
  position: readonly [number, number, number]
}

export const PLANET_SPOTS: readonly PlanetSpot[] = [
  {
    id: 'challenges',
    label: 'Challenges',
    heading: 'Two-step evaluation, up to $25,000',
    body: 'Pass the evaluation, get the account. Up to $25,000 simulated capital and an 80% profit split on everything you earn.',
    ctaLabel: 'See the challenge',
    href: '#challenges',
    position: [0.28, 0.42, 0.86],
  },
  {
    id: 'rules',
    label: 'Evaluation Rules',
    heading: 'No time limit. Clear limits.',
    body: 'Zero time limits and no calendar pressure. Daily loss resets at 00:00 server time; overall drawdown is static or trailing. On funded accounts no single day may exceed 20% of total profit in a payout cycle.',
    ctaLabel: 'Read the rules',
    href: '#rules',
    position: [-0.64, 0.46, 0.61],
  },
  {
    id: 'payouts',
    label: 'Payout Proofs',
    heading: 'Payouts you can verify',
    body: 'Weekly payout cycle, 1–3 day payout review, and published proof of every disbursement — not promises.',
    ctaLabel: 'See payout proof',
    href: '#payouts',
    position: [0.68, -0.18, 0.68],
  },
  {
    id: 'platforms',
    label: 'Trading Platforms',
    heading: 'Trade on PFT Web Terminal',
    body: 'Same charts, same execution, the same account. Instant credentials the moment your evaluation is passed.',
    ctaLabel: 'See the platform',
    href: '#platforms',
    position: [-0.3, -0.68, 0.66],
  },
  {
    id: 'faq',
    label: 'FAQ',
    heading: 'The short answers',
    body: 'Trading days, scaling, payouts and the rules of the challenge — the short answers to what traders ask most.',
    ctaLabel: 'Open the FAQ',
    href: '#faq',
    position: [0.2, 0.75, -0.63],
  },
] as const
