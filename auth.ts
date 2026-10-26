import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import { prisma } from '@/lib/prisma'

const googleClientId = process.env.AUTH_GOOGLE_ID
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET || process.env.TRADER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET,
  trustHost: true,
  session: { strategy: 'jwt' },
  pages: { signIn: '/auth/login' },
  providers:
    googleClientId && googleClientSecret
      ? [Google({ clientId: googleClientId, clientSecret: googleClientSecret })]
      : [],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google' || !user.email) return false
      if ((profile as { email_verified?: unknown } | undefined)?.email_verified !== true) return false

      const email = user.email.trim().toLowerCase()
      const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true, role: true, tokenVersion: true },
      })
      if (existing && existing.role !== 'TRADER') return false

      const trader = existing
        ? await prisma.user.update({
            where: { id: existing.id },
            data: {
              emailVerifiedAt: new Date(),
              ...(user.image ? { avatarUrl: user.image } : {}),
            },
            select: { id: true, tokenVersion: true },
          })
        : await prisma.user.create({
            data: {
              email,
              name: user.name?.trim() || email.split('@')[0],
              passwordHash: 'oauth-only',
              role: 'TRADER',
              emailVerifiedAt: new Date(),
              avatarUrl: user.image,
            },
            select: { id: true, tokenVersion: true },
          })
      user.id = trader.id
      ;(user as typeof user & { tokenVersion?: number }).tokenVersion = trader.tokenVersion
      return true
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id
        const version = (user as typeof user & { tokenVersion?: number }).tokenVersion
        if (typeof version === 'number') token.tokenVersion = version
      }

      if (token.sub) {
        const current = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { tokenVersion: true, role: true },
        })
        const tokenVersion = typeof token.tokenVersion === 'number' ? token.tokenVersion : 0
        if (!current || current.role !== 'TRADER' || current.tokenVersion !== tokenVersion) return null
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub
      return session
    },
  },
})
