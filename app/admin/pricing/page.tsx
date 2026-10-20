import { redirect } from 'next/navigation'
import { AdminPricing } from '@/components/admin/admin-pricing'
import { getAdminSession } from '@/lib/admin/auth'

export const metadata = {
  title: 'Challenge Pricing — Professional Funded Trader',
  robots: { index: false, follow: false },
}

export default async function AdminPricingPage() {
  const session = await getAdminSession()
  if (!session) redirect('/admin/login')
  if (session.role !== 'ADMIN') redirect('/admin')
  return <AdminPricing email={session.email} />
}
