/**
 * Backfill Brief on existing AI-handoff messages.
 *
 * Before the Brief refactor, `lib/ai/support-chat.ts` stored a large service
 * block ("Message from the PFT assistant chat:", "AI handoff reason:", etc.)
 * as the first message of a ticket. This script:
 *   - finds messages starting with that prefix,
 *   - parses the blocks,
 *   - replaces body with the trader's own text,
 *   - sets metadata: { source: 'agent', brief: { ... } },
 *   - on parse failure, skips the message (safe).
 *
 * Usage:
 *   tsx scripts/support-brief-backfill.ts          # dry run
 *   tsx scripts/support-brief-backfill.ts --apply  # write changes
 */
import { prisma } from '@/lib/prisma'
import type { SupportBrief } from '@/lib/support/brief'

const MARKER = 'Message from the PFT assistant chat:'

const applied = process.argv.includes('--apply')

async function main() {
  const messages = await prisma.supportMessage.findMany({
    where: { body: { startsWith: MARKER } },
    orderBy: { createdAt: 'asc' },
  })

  let found = 0
  let convertible = 0
  let skipped = 0

  for (const message of messages) {
    found += 1
    const parsed = parseBriefFromLegacy(message.body)
    if (!parsed) {
      skipped += 1
      console.log(`skip: ${message.id} (parse failed)`)
      continue
    }
    convertible += 1
    if (!applied) {
      console.log(`[dry] convert: ${message.id} — reason: ${parsed.brief.reason.slice(0, 60)}…`)
      continue
    }
    await prisma.supportMessage.update({
      where: { id: message.id },
      data: { body: parsed.body, metadata: { source: 'agent', brief: parsed.brief } },
    })
    console.log(`[apply] converted: ${message.id}`)
  }

  console.log(`found=${found} convertible=${convertible} skipped=${skipped} applied=${applied}`)
  if (!applied) console.log('Run with --apply to write changes.')
}

main()
  .catch((error) => {
    console.error('[backfill] failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })

/**
 * Parse the legacy format and extract the Brief fields.
 *
 * Expected legacy layout:
 *   Message from the PFT assistant chat:
 *   <trader message>
 *   AI handoff reason: <reason>
 *   Conversation context (most recent turns):
 *   <excerpt lines>
 *   Trader context (server-side):
 *   KYC: <status>
 *   Accounts (newest first, max 3):
 *   - DISPLAYID · STATUS · $PLAN · PHASE
 *   Rules version: <v>
 */
function parseBriefFromLegacy(raw: string): { body: string; brief: SupportBrief } | null {
  const markerIdx = raw.indexOf(MARKER)
  if (markerIdx === -1) return null
  const afterMarker = raw.slice(markerIdx + MARKER.length).replace(/^[\n]+/, '')
  const reasonIdx = afterMarker.indexOf('AI handoff reason:')
  if (reasonIdx === -1) return null
  const body = afterMarker.slice(0, reasonIdx).trim()
  const reasonMatch = /AI handoff reason:\s*([^\n]*)/.exec(afterMarker)
  const reason = reasonMatch?.[1]?.trim()
  if (!body || !reason) return null

  const versionMatch = /Rules version:\s*([\w.]+)/.exec(afterMarker)
  const rulesVersion = versionMatch?.[1] ?? 'unknown'

  const contextStart = afterMarker.indexOf('Trader context (server-side):')
  const context = contextStart !== -1 ? parseContextBlock(afterMarker.slice(contextStart)) : { kycStatus: 'unknown', accounts: [] }

  const history = parseHistory(afterMarker.slice(afterMarker.indexOf('Conversation context (most recent turns):')).split('Trader context')[0])

  return {
    body,
    brief: {
      source: 'agent',
      reason,
      category: 'GENERAL',
      rulesVersion,
      history,
      context,
    },
  }
}

function parseContextBlock(block: string): SupportBrief['context'] {
  const accounts: SupportBrief['context']['accounts'] = []
  const kycMatch = /KYC:\s*([^\n]*)/.exec(block)
  const kycStatus = kycMatch?.[1]?.trim() ?? 'unknown'
  for (const line of block.split('\n')) {
    const match = /^-\s*([A-Z]+-[A-Z0-9]+)\s*·\s*([^·]+?)\s*·\s*\$([\d,]+)\s*·\s*(.+?)$/.exec(line.trim())
    if (!match) continue
    accounts.push({
      displayId: match[1],
      status: match[2],
      planSize: Number(match[3].replace(/,/g, '')),
      phase: match[4],
    })
  }
  return { kycStatus, accounts: accounts.slice(0, 3) }
}

function parseHistory(excerpt: string): SupportBrief['history'] {
  const history: SupportBrief['history'] = []
  for (const line of excerpt.split('\n')) {
    const match = /^(Trader|Assistant):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    history.push({ role: match[1] === 'Trader' ? 'user' : 'assistant', content: match[2] })
  }
  return history
}
