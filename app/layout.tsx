import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { cookies } from 'next/headers'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PFTIntroProvider } from '@/components/pft-intro/PFTIntroProvider'
import './globals.css'

const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

export const metadata: Metadata = {
  title: 'Professional Funded Trader (PFT) — Trade up to $200K in Simulated Capital',
  description:
    'Get funded with Professional Funded Trader. 1-Step and 2-Step evaluations up to $200,000 aggregate allocation, 80% profit split, no time limits, and weekly payouts on the PFT terminal.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#02040a',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const introShown = (await cookies()).has('pft_intro')

  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} bg-background`}>
      <body className="antialiased">
        <TooltipProvider>
          <PFTIntroProvider initialShow={!introShown}>{children}</PFTIntroProvider>
        </TooltipProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
