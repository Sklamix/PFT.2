import { prisma } from '@/lib/prisma'
import { MAX_ACTIVE_ACCOUNTS, MAX_AGGREGATE_ALLOCATION } from './limits'

const ACTIVE_STATUSES = ['ACTIVE', 'FUNDED', 'PASSED', 'PASSED_PHASE_1', 'PASSED_PHASE_2'] as const

export type ClusterLink = 'phone' | 'ip_device'

export type RelatedClusterUser = {
  id: string
  name: string
  email: string
  riskFlagged: boolean
}

export type RelatedClusterAccount = {
  id: string
  displayId: string
  planSize: number
  status: string
}

export type RelatedAccountCluster = {
  /** Stable identifier derived from member ids, so audits can be compared over time. */
  id: string
  users: RelatedClusterUser[]
  accounts: RelatedClusterAccount[]
  activeCount: number
  allocation: number
  exceedsLimits: boolean
  links: ClusterLink[]
}

type Candidate = {
  id: string
  name: string
  email: string
  phone: string | null
  lastLoginIp: string | null
  lastDeviceHash: string | null
  riskFlaggedAt: Date | null
}

/**
 * Groups users that limits already treat as related: same phone number, or the
 * same IP + device fingerprint. Limits are enforced per related group, so this
 * view exists to show the group as one unit instead of one trader at a time.
 */
export async function findRelatedAccountClusters(): Promise<RelatedAccountCluster[]> {
  const users: Candidate[] = await prisma.user.findMany({
    where: { accounts: { some: {} } },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      lastLoginIp: true,
      lastDeviceHash: true,
      riskFlaggedAt: true,
    },
  })
  if (users.length < 2) return []

  const parent = new Map<string, string>(users.map((user) => [user.id, user.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let current = id
    while (parent.get(current) !== current) {
      const next = parent.get(current) as string
      parent.set(current, root)
      current = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }

  const phoneGroups = new Map<string, string[]>()
  const deviceGroups = new Map<string, string[]>()
  for (const user of users) {
    const phone = user.phone?.trim()
    if (phone) {
      const group = phoneGroups.get(phone) ?? []
      group.push(user.id)
      phoneGroups.set(phone, group)
    }
    const ip = user.lastLoginIp?.trim()
    const hash = user.lastDeviceHash?.trim()
    if (ip && hash) {
      const key = `${ip}|${hash}`
      const group = deviceGroups.get(key) ?? []
      group.push(user.id)
      deviceGroups.set(key, group)
    }
  }

  const phoneLinks: string[][] = []
  for (const group of phoneGroups.values()) {
    if (group.length < 2) continue
    group.slice(1).forEach((id) => union(group[0], id))
    phoneLinks.push(group)
  }
  const deviceLinks: string[][] = []
  for (const group of deviceGroups.values()) {
    if (group.length < 2) continue
    group.slice(1).forEach((id) => union(group[0], id))
    deviceLinks.push(group)
  }
  // Resolve link roots only after every union, otherwise a later merge can
  // orphan a root recorded earlier.
  const phoneRoots = new Set(phoneLinks.map((group) => find(group[0])))
  const deviceRoots = new Set(deviceLinks.map((group) => find(group[0])))

  const byRoot = new Map<string, Candidate[]>()
  for (const user of users) {
    const root = find(user.id)
    const group = byRoot.get(root) ?? []
    group.push(user)
    byRoot.set(root, group)
  }

  const clusters = [...byRoot.values()].filter((group) => group.length > 1)
  if (clusters.length === 0) return []

  const accounts = await prisma.tradingAccount.findMany({
    where: {
      userId: { in: clusters.flatMap((group) => group.map((user) => user.id)) },
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { id: true, displayId: true, planSize: true, status: true, userId: true },
  })

  return clusters
    .map((group) => {
      const ids = new Set(group.map((user) => user.id))
      const groupAccounts = accounts.filter((account) => ids.has(account.userId))
      const allocation = groupAccounts.reduce((sum, account) => sum + account.planSize, 0)
      const links: ClusterLink[] = []
      // `find` is stable after all unions, so the root matches every member.
      const root = find(group[0].id)
      if (phoneRoots.has(root)) links.push('phone')
      if (deviceRoots.has(root)) links.push('ip_device')
      return {
        id: [...ids].sort().join(':'),
        users: group.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          riskFlagged: Boolean(user.riskFlaggedAt),
        })),
        accounts: groupAccounts.map((account) => ({
          id: account.id,
          displayId: account.displayId,
          planSize: account.planSize,
          status: account.status,
        })),
        activeCount: groupAccounts.length,
        allocation,
        exceedsLimits: groupAccounts.length > MAX_ACTIVE_ACCOUNTS || allocation > MAX_AGGREGATE_ALLOCATION,
        links,
      }
    })
    .sort((a, b) => b.allocation - a.allocation || b.activeCount - a.activeCount)
}
