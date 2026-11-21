import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'Support Desk',
  description: 'Тикети підтримки для працівників',
  manifest: '/staff-manifest.webmanifest',
  icons: { icon: '/icon.svg' },
}

export const viewport: Viewport = {
  themeColor: '#0b0b0f',
  width: 'device-width',
  initialScale: 1,
}

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return children
}
