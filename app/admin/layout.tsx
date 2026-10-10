import type { ReactNode } from 'react'

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="dark min-h-dvh bg-[#090D16] text-foreground">{children}</div>
}
