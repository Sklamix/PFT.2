import { redirect } from 'next/navigation'
import { AdminDesk } from '@/components/admin/admin-desk'
import { getAdminSession } from '@/lib/admin/auth'

export const metadata = {
  title: 'Operations Desk — Professional Funded Trader',
  robots: { index: false, follow: false },
}

export default async function AdminPage() {
  const session = await getAdminSession()
  if (!session) redirect('/admin/login')
  return <AdminDesk user={session} />
}
