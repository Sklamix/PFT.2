'use client'

import { useState } from 'react'
import { Banknote, Bell, ChevronDown, Clock, KeyRound, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNow } from '@/hooks/use-now'
import { ACCOUNTS, NOTIFICATIONS, formatClock, formatUsd, nextUtcMidnight, type TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'
import { StatusDot } from './status-dot'

type TopBarProps = {
  account: TradingAccount
  onAccountChange: (id: string) => void
  onOpenMenu: () => void
  onOpenCredentials: () => void
  onRequestPayout: () => void
}

export function TopBar({ account, onAccountChange, onOpenMenu, onOpenCredentials, onRequestPayout }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-md sm:gap-3 lg:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMenu} aria-label="Open navigation">
        <Menu className="size-5" aria-hidden="true" />
      </Button>

      <AccountSelector account={account} onAccountChange={onAccountChange} />

      <div className="ml-auto flex items-center gap-2">
        <ResetClock />
        <Button size="sm" className="hidden md:inline-flex" onClick={onRequestPayout}>
          <Banknote className="size-4" aria-hidden="true" />
          Request Payout
        </Button>
        <Button variant="outline" size="icon-sm" onClick={onOpenCredentials} aria-label="Show MT5 login credentials">
          <KeyRound className="size-4" aria-hidden="true" />
        </Button>
        <NotificationsMenu />
      </div>
    </header>
  )
}

function AccountSelector({ account, onAccountChange }: Pick<TopBarProps, 'account' | 'onAccountChange'>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-1.5 text-left transition-colors hover:border-muted-foreground/40 aria-expanded:border-primary/40"
        aria-label={`Active account ${account.id}. Change account`}
      >
        <StatusDot status={account.status} />
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs font-semibold text-foreground sm:text-sm">{account.id}</span>
          <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
            {formatUsd(account.size, { compact: true })} Tier · {account.statusLabel}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Switch trading account</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={account.id} onValueChange={(value) => onAccountChange(String(value))}>
            {ACCOUNTS.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id} className="py-2">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs font-semibold">{item.id}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot status={item.status} />
                    {formatUsd(item.size, { compact: true })} · {item.phase} · {item.statusLabel}
                  </span>
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ResetClock() {
  const now = useNow()
  const remaining = now === null ? null : nextUtcMidnight(now) - now
  const serverTime = now === null ? '--:--:--' : new Date(now).toISOString().slice(11, 19)

  return (
    <div
      className="hidden items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-1.5 sm:flex"
      aria-label="Daily drawdown reset countdown"
    >
      <Clock className="size-4 text-highlight motion-safe:animate-pulse" aria-hidden="true" />
      <div className="font-mono leading-tight">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="hidden xl:inline">Server {serverTime} UTC · </span>Reset in
        </p>
        <p className="text-xs font-semibold tabular-nums text-foreground" aria-live="off">
          {remaining === null ? '--:--:--' : formatClock(remaining)}
        </p>
      </div>
    </div>
  )
}

const TONE_CLASS = {
  primary: 'bg-primary',
  highlight: 'bg-highlight',
  danger: 'bg-danger',
} as const

function NotificationsMenu() {
  const [readIds, setReadIds] = useState<string[]>([])
  const unread = NOTIFICATIONS.filter((item) => !readIds.includes(item.id)).length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="relative flex size-8 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
        aria-label={`Notifications, ${unread} unread`}
      >
        <Bell className="size-4" aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-danger font-mono text-[9px] font-bold text-white">
            {unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <div className="flex items-center justify-between px-2 py-1.5">
            <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
            <button
              type="button"
              className="text-xs text-highlight hover:underline disabled:text-muted-foreground disabled:no-underline"
              onClick={() => setReadIds(NOTIFICATIONS.map((item) => item.id))}
              disabled={unread === 0}
            >
              Mark all read
            </button>
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <ul className="flex flex-col">
          {NOTIFICATIONS.map((item) => {
            const isRead = readIds.includes(item.id)
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setReadIds((ids) => (ids.includes(item.id) ? ids : [...ids, item.id]))}
                  className="flex w-full gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                >
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', isRead ? 'bg-transparent' : TONE_CLASS[item.tone])} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className={cn('block text-sm', isRead ? 'text-muted-foreground' : 'font-medium text-foreground')}>{item.title}</span>
                    <span className="block text-xs text-muted-foreground">{item.body}</span>
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{item.time}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
