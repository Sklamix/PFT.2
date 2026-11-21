import { redirect } from 'next/navigation'
import { PaymentRecoveryPanel } from '@/components/admin/payment-recovery'
import { getAdminSession } from '@/lib/admin/auth'

export const metadata = {
  title: 'Payment Recovery — Professional Funded Trader',
  robots: { index: false, follow: false },
}

export default async function PaymentRecoveryPage() {
  const session = await getAdminSession()
  if (!session) redirect('/admin/login')
  return <PaymentRecoveryPanel />
}
