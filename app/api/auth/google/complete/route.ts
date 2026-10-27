import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { resolveSafeNextPath } from '@/lib/auth/safe-next-path'
import { applyTraderCookie, issueTraderSession } from '@/lib/trader/auth'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId || !session.user.email) {
    return NextResponse.redirect(new URL('/auth/login?error=google', request.url))
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, profileCompletedAt: true, tokenVersion: true },
  })
  if (!user || user.role !== 'TRADER') {
    return NextResponse.redirect(new URL('/auth/login?error=google', request.url))
  }

  const url = new URL(request.url)
  const destination = user.profileCompletedAt
    ? resolveSafeNextPath(url.searchParams.get('next'), request.url, '/dashboard')
    : '/profile/setup'
  const issued = await issueTraderSession(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      tokenVersion: user.tokenVersion,
    },
    request,
  )
  return applyTraderCookie(NextResponse.redirect(new URL(destination, request.url)), issued)
}
