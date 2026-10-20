import { redirect } from 'next/navigation'
import { ProfileForm } from '@/components/profile/profile-form'
import { getTraderSession } from '@/lib/trader/auth'

export const metadata = { title: 'Set up profile — Professional Funded Trader', robots: { index: false, follow: false } }

export default async function ProfileSetupPage() {
  const session = await getTraderSession()
  if (!session) redirect('/auth/login')
  return <ProfileForm mode="setup" />
}
