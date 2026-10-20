import { redirect } from 'next/navigation'
import { ProfileForm } from '@/components/profile/profile-form'
import { getTraderSession } from '@/lib/trader/auth'

export const metadata = { title: 'Profile settings — Professional Funded Trader', robots: { index: false, follow: false } }

export default async function ProfileSettingsPage() {
  const session = await getTraderSession()
  if (!session) redirect('/auth/login')
  return <ProfileForm mode="settings" />
}
