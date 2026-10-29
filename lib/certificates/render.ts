import QRCode from 'qrcode'
import { TYPE_TITLES, type CertificateTheme, type CertificateType } from './types'

const DEFAULT_APP_URL = 'https://pft-app-prod.vercel.app'

export function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '')
}

export function verifyUrl(publicId: string) {
  return `${appUrl()}/verify/${encodeURIComponent(publicId)}`
}

const THEME_COLORS: Record<CertificateTheme, { accent: string; accentSoft: string; ring: string; sub: string }> = {
  GOLD: { accent: '#f5c76a', accentSoft: 'rgba(245,199,106,0.14)', ring: '#c89b3c', sub: '#9aa4b2' },
  SILVER: { accent: '#cbd5e1', accentSoft: 'rgba(203,213,225,0.12)', ring: '#8a97a8', sub: '#94a3b8' },
  NEBULA: { accent: '#8b9cf5', accentSoft: 'rgba(139,156,245,0.14)', ring: '#5b6cc4', sub: '#9aa4b2' },
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const STARS: [number, number, number][] = [
  [90, 90, 1.2], [1180, 120, 1.6], [640, 70, 1.1], [1080, 560, 1.3], [170, 620, 1.5],
  [300, 180, 1.0], [940, 200, 1.2], [780, 640, 1.1], [1200, 420, 1.4], [60, 360, 1.0],
]

function nameFontSize(name: string): number {
  const len = name.length
  if (len <= 18) return 56
  if (len <= 28) return 46
  if (len <= 38) return 38
  return 32
}

export type CertificateRenderInput = {
  publicId: string
  type: CertificateType
  displayName: string
  accountLabel: string | null
  amountLabel: string | null
  issuedAt: string
  theme: CertificateTheme
  symbol: string | null
  status: 'VERIFIED' | 'REVOKED'
}

export async function renderCertificateSvg(input: CertificateRenderInput): Promise<string> {
  const colors = THEME_COLORS[input.theme]
  const title = TYPE_TITLES[input.type]
  const url = verifyUrl(input.publicId)

  // Real QR code → PNG data URL, embedded at a fixed reserved area.
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b0f19', light: '#ffffff' },
  })

  const fontSize = nameFontSize(input.displayName)
  const symbolGlyph = input.symbol ? `<text x="1184" y="150" font-size="72" text-anchor="end">${escapeXml(input.symbol)}</text>` : ''

  const amountRow = input.amountLabel
    ? `<text x="88" y="520" font-family="Menlo, Consolas, monospace" font-size="30" fill="${colors.accent}">${escapeXml(input.amountLabel)}</text>`
    : ''
  const accountRow = input.accountLabel
    ? `<text x="88" y="468" font-family="Menlo, Consolas, monospace" font-size="24" fill="#c7d2df">${escapeXml(input.accountLabel)}</text>`
    : ''

  const statusMark = input.status === 'REVOKED'
    ? `<rect x="88" y="300" width="340" height="40" rx="20" fill="#7f1d1d"/><text x="258" y="326" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="16" letter-spacing="2" fill="#fecaca">REVOKED</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
  <defs>
    <radialGradient id="bg" cx="28%" cy="20%" r="95%">
      <stop offset="0%" stop-color="#111a33"/>
      <stop offset="55%" stop-color="#080d1c"/>
      <stop offset="100%" stop-color="#04060e"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${colors.accent}"/>
      <stop offset="100%" stop-color="transparent"/>
    </linearGradient>
    <radialGradient id="planetGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${colors.accentSoft}"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>

  <rect width="1280" height="720" fill="url(#bg)"/>
  ${STARS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#e0f2fe" opacity="0.35"/>`).join('')}

  <rect x="64" y="64" width="1152" height="592" rx="20" fill="none" stroke="${colors.ring}" stroke-opacity="0.45" stroke-width="1"/>
  <rect x="64" y="64" width="240" height="1.5" fill="url(#ring)"/>

  <!-- Brand -->
  <g transform="translate(88,88)">
    <rect x="0" y="0" width="54" height="34" rx="8" fill="${colors.accent}"/>
    <text x="27" y="23" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="15" font-weight="700" fill="#0b0f19">PFT</text>
    <text x="68" y="18" font-size="11" letter-spacing="3" fill="#8a97a8">PROFESSIONAL</text>
    <text x="68" y="32" font-size="11" letter-spacing="3" fill="#8a97a8">FUNDED TRADER</text>
  </g>

  <!-- Personal symbol (designated area, never overlaps critical text) -->
  ${symbolGlyph}

  <!-- Achievement title -->
  <text x="88" y="230" font-size="18" letter-spacing="5" fill="${colors.accent}">${escapeXml(title)}</text>

  ${statusMark}

  <!-- Trader name -->
  <text x="88" y="388" font-size="${fontSize}" font-weight="600" fill="#f4f7fb">${escapeXml(input.displayName)}</text>

  ${accountRow}
  ${amountRow}

  <!-- Issue date + certificate id -->
  <text x="88" y="600" font-family="Menlo, Consolas, monospace" font-size="16" fill="#8a97a8">Issued ${escapeXml(input.issuedAt)}</text>
  <text x="88" y="628" font-family="Menlo, Consolas, monospace" font-size="16" letter-spacing="1" fill="#8a97a8">Certificate ID ${escapeXml(input.publicId)}</text>

  <!-- Reserved QR region (fixed, protected) -->
  <g transform="translate(952,440)">
    <rect x="-12" y="-12" width="252" height="252" rx="16" fill="#ffffff"/>
    <image href="${qrDataUrl}" x="0" y="0" width="228" height="228"/>
  </g>
  <text x="1078" y="712" text-anchor="middle" font-family="Menlo, Consolas, monospace" font-size="13" letter-spacing="2" fill="#8a97a8">SCAN TO VERIFY</text>
</svg>`
}
