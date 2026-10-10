import type { ReactNode } from 'react'
import { BrandLogo } from '@/components/brand-logo'
import type { AdminSession } from '@/lib/admin/types'

export function AdminDeskFrame({
  user,
  actions,
  children,
}: {
  user: AdminSession
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-h-dvh bg-[#090D16]">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-[#090D16]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-4 px-4 lg:px-6">
          <div className="flex items-center gap-4">
            <BrandLogo href="/" />
            <div className="hidden border-l border-border pl-4 sm:block">
              <p className="text-[11px] tracking-[0.18em] text-highlight uppercase">Operations Desk</p>
              <p className="font-mono text-xs text-muted-foreground">{user.role}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <p className="hidden font-mono text-xs text-muted-foreground md:block">{user.email}</p>
            {actions}
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4 lg:gap-5 lg:p-6">{children}</main>
    </div>
  )
}
