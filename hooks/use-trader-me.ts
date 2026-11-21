'use client'

import { useEffect, useState } from 'react'

import { redirectToLogin } from '@/lib/stores/useTerminalBook'

export interface TraderMeUser {
  email: string
  name: string
}

type TraderMeResponse = { trader?: TraderMeUser }

// Module-level cache: every shell on the page renders SidebarContent, but the
// /api/auth/me lookup runs once per page load and its result is shared.
let cachedUser: TraderMeUser | null = null
let pending: Promise<TraderMeUser | null> | null = null

async function loadCurrentUser(): Promise<TraderMeUser | null> {
  const response = await fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null)
  if (!response) return null
  if (response.status === 401) {
    redirectToLogin()
    return null
  }
  const data = (await response.json().catch(() => null)) as TraderMeResponse | null
  return data?.trader ?? null
}

function sharedLoad(): Promise<TraderMeUser | null> {
  pending ??= loadCurrentUser().then((user) => {
    cachedUser = user
    pending = null
    return user
  })
  return pending
}

/** Resolves the signed-in trader once per page load; null while loading. */
export function useTraderMe(): TraderMeUser | null {
  const [user, setUser] = useState<TraderMeUser | null>(cachedUser)

  useEffect(() => {
    if (cachedUser) return
    let alive = true
    void sharedLoad().then((loaded) => {
      if (alive) setUser(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  return user
}
