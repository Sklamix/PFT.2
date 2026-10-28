'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { SidebarContent } from '@/components/dashboard/sidebar'
import { Button } from '@/components/ui/button'
import { Menu } from 'lucide-react'
import { OverviewCockpit } from './overview-cockpit'

export function OverviewShell() {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex min-h-dvh bg-transparent lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-border bg-sidebar lg:block">
        <SidebarContent view="overview" onNavigate={() => router.push('/dashboard/terminal')} />
      </aside>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 border-border bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Dashboard sections</SheetDescription>
          <SidebarContent
            view="overview"
            onNavigate={() => {
              setMenuOpen(false)
              router.push('/dashboard/terminal')
            }}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
            <Menu className="size-5" />
          </Button>
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Overview</p>
        </div>
        <OverviewCockpit />
      </div>
    </div>
  )
}
