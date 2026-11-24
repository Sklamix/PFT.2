import { Prisma } from '@prisma/client'

/**
 * True when Prisma reports that a table or column the query needs does not
 * exist in the database (P2021 / P2022).
 *
 * This happens when a deploy ships ahead of its schema — the code knows about
 * `PriceAlert` but `prisma db push` has not reached that environment yet. The
 * production and preview environments use different `DATABASE_URL` values, so
 * the preview database can have the table while production does not.
 *
 * Callers should translate this into a legible message for the user instead of
 * letting it surface as an unhandled 500.
 */
export function isMissingSchema(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2021' || error.code === 'P2022'
  }
  return false
}

export const ALERTS_NOT_ENABLED_MESSAGE =
  'Alerts are not enabled on this environment yet. The database schema is still being applied — please try again shortly.'
