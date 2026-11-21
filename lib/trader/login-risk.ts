import { prisma } from '@/lib/prisma'
import { clientIp } from '@/lib/security/client-ip'

/**
 * Step-up risk policy for password sign-ins. Conservative by design:
 *   - a brand-new IP steps up, but a first-ever login (no stored IP) does not;
 *   - repeated failed password attempts since the last success step up once the
 *     counter exceeds FAILED_LOGIN_RISK_THRESHOLD.
 */
export const FAILED_LOGIN_RISK_THRESHOLD = 1

/** Prefix key: /32 for IPv4, /48 (first three groups) for IPv6. */
function ipPrefixKey(ip: string) {
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean)
    return groups.slice(0, 3).join(',')
  }
  return ip
}

export function loginIpChanged(previous: string | null, current: string): boolean {
  if (!previous || !current || current === 'unknown') return false
  return ipPrefixKey(previous) !== ipPrefixKey(current)
}

export interface LoginRiskInput {
  lastLoginIp: string | null
  failedLoginCount: number
}

export function isLoginRisky(input: LoginRiskInput, currentIp: string): boolean {
  if (input.failedLoginCount > FAILED_LOGIN_RISK_THRESHOLD) return true
  return loginIpChanged(input.lastLoginIp, currentIp)
}

/** One failed password attempt for this account since its last successful login. */
export async function recordFailedLogin(email: string): Promise<void> {
  await prisma.user.updateMany({
    where: { email },
    data: { failedLoginCount: { increment: 1 } },
  })
}

/** Successful password login: store the context risk was computed against and reset the counter. */
export async function recordSuccessfulLogin(userId: string, request: Request): Promise<void> {
  const userAgent = request.headers.get('user-agent')?.slice(0, 512) ?? null
  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginIp: clientIp(request), lastLoginUserAgent: userAgent, failedLoginCount: 0 },
    select: { id: true },
  })
}

export async function getLoginRiskContext(email: string): Promise<LoginRiskInput | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { lastLoginIp: true, failedLoginCount: true },
  })
  return user ?? null
}
