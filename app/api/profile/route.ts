import { NextResponse } from 'next/server'
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { prisma } from '@/lib/prisma'
import { countryByValue } from '@/lib/countries'
import { requireTrader } from '@/lib/trader/auth'
import { recordActivity } from '@/lib/admin/activity'

export const dynamic = 'force-dynamic'

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u
const NICKNAME_PATTERN = /^[\p{L}\p{M}\p{N}._-]{2,30}$/u
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    const profile = await prisma.user.findUnique({
      where: { id: session.sub },
      select: {
        email: true,
        name: true,
        nickname: true,
        dateOfBirth: true,
        phone: true,
        country: true,
        avatarUrl: true,
        emailVerifiedAt: true,
        profileCompletedAt: true,
        declaredVpsCountry: true,
      },
    })
    if (!profile) return NextResponse.json({ error: 'Profile not found.' }, { status: 404 })
    return NextResponse.json({
      profile: {
        ...profile,
        dateOfBirth: profile.dateOfBirth?.toISOString().slice(0, 10) ?? '',
      },
    })
  } catch (cause) {
    console.error('Failed to load trader profile', cause)
    return NextResponse.json({ error: 'Unable to load your profile.' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 })
  }

  const input = body as Record<string, unknown>
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  const nickname = typeof input.nickname === 'string' ? input.nickname.trim() : ''
  const dateOfBirth = typeof input.dateOfBirth === 'string' ? input.dateOfBirth.trim() : ''
  const country = typeof input.country === 'string' ? input.country.trim() : ''
  const rawPhone = typeof input.phone === 'string' ? input.phone.trim() : ''
  const residence = countryByValue(country)
  const parsedPhone = parsePhoneNumberFromString(rawPhone)
  const parsedBirthDate = DATE_PATTERN.test(dateOfBirth) ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null
  const hasVpsField = Object.prototype.hasOwnProperty.call(input, 'declaredVpsCountry')
  const rawVpsCountry = typeof input.declaredVpsCountry === 'string' ? input.declaredVpsCountry.trim() : ''
  const vpsResidence = rawVpsCountry ? countryByValue(rawVpsCountry) : null

  if (!NAME_PATTERN.test(name)) {
    return NextResponse.json({ error: 'Enter a first and last name (2–100 characters).' }, { status: 400 })
  }
  if (!NICKNAME_PATTERN.test(nickname)) {
    return NextResponse.json({ error: 'Nickname must be 2–30 letters, numbers, dots, underscores or hyphens.' }, { status: 400 })
  }
  if (!parsedBirthDate || Number.isNaN(parsedBirthDate.getTime()) || parsedBirthDate.toISOString().slice(0, 10) !== dateOfBirth || parsedBirthDate > new Date()) {
    return NextResponse.json({ error: 'Enter a valid date of birth in the past.' }, { status: 400 })
  }
  if (!residence) {
    return NextResponse.json({ error: 'Select a valid country of residence.' }, { status: 400 })
  }
  if (!parsedPhone?.isValid()) {
    return NextResponse.json({ error: 'Enter a valid phone number in international format.' }, { status: 400 })
  }
  if (hasVpsField && rawVpsCountry && !vpsResidence) {
    return NextResponse.json({ error: 'Select a valid VPS country or leave the field empty.' }, { status: 400 })
  }

  try {
    const profile = await prisma.user.update({
      where: { id: session.sub },
      data: {
        name,
        nickname,
        dateOfBirth: parsedBirthDate,
        country: residence.code,
        phone: parsedPhone.number,
        profileCompletedAt: new Date(),
        ...(hasVpsField
          ? {
              declaredVpsCountry: vpsResidence?.code ?? null,
              vpsDeclaredAt: vpsResidence ? new Date() : null,
            }
          : {}),
      },
      select: {
        email: true,
        name: true,
        nickname: true,
        dateOfBirth: true,
        country: true,
        phone: true,
        declaredVpsCountry: true,
      },
    })
    void recordActivity({
      actorId: session.sub,
      action: 'TRADER_PROFILE_UPDATED',
      request,
      metadata: { country: residence.code, vpsDeclared: Boolean(vpsResidence), hasVpsField },
    })
    return NextResponse.json({
      profile: { ...profile, dateOfBirth: profile.dateOfBirth?.toISOString().slice(0, 10) ?? '' },
    })
  } catch (cause) {
    console.error('Failed to update trader profile', cause)
    return NextResponse.json({ error: 'Unable to save your profile.' }, { status: 500 })
  }
}
