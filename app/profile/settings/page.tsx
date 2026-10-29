import { redirect } from 'next/navigation'

export const metadata = { title: 'Settings — Professional Funded Trader', robots: { index: false, follow: false } }

export default function ProfileSettingsPage() {
  redirect('/dashboard/settings')
}
