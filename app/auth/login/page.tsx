import type { Metadata } from 'next'
import { AuthPortal } from '@/components/auth/auth-portal'

export const metadata: Metadata = {
  title: 'Sign in — Professional Funded Trader',
  robots: { index: false, follow: false },
}

export default function AuthLoginPage() {
  return (
    <AuthPortal
      googleEnabled={Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET)}
    />
  )
}
