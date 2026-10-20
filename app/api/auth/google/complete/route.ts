import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { applyTraderCookie } from '@/lib/trader/auth'
import { prisma } from '@/lib/prisma'

function safeNextPath(value: string | null) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard'
}

export async function GET(request: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId || !session.user.email) {
    return NextResponse.redirect(new URL('/auth/login?error=google', request.url))
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, profileCompletedAt: true },
  })
  if (!user || user.role !== 'TRADER') {
    return NextResponse.redirect(new URL('/auth/login?error=google', request.url))
  }

  const url = new URL(request.url)
  const destination = user.profileCompletedAt ? safeNextPath(url.searchParams.get('next')) : '/profile/setup'
  return applyTraderCookie(NextResponse.redirect(new URL(destination, request.url)), {
    sub: user.id,
    email: user.email,
    name: user.name,
  })
}
