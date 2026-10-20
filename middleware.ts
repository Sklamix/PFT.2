import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { ADMIN_COOKIE } from '@/lib/admin/constants'
import { TRADER_COOKIE } from '@/lib/trader/constants'

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    if (!request.cookies.get(ADMIN_COOKIE)?.value) {
      const url = request.nextUrl.clone()
      url.pathname = '/admin/login'
      return NextResponse.redirect(url)
    }
  }
  // Cookie presence gates the pages; the session itself is verified by every /api/trading/* and /api/auth/me call.
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/') || pathname.startsWith('/profile/')) {
    if (!request.cookies.get(TRADER_COOKIE)?.value) {
      const url = request.nextUrl.clone()
      url.pathname = '/auth/login'
      url.search = `?next=${encodeURIComponent(pathname + search)}`
      return NextResponse.redirect(url)
    }
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*', '/dashboard', '/dashboard/:path*', '/profile/:path*'],
}
