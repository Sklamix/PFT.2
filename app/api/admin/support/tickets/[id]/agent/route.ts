import { NextResponse } from 'next/server'
import { assertSameOrigin } from '@/lib/security/csrf'
import { handleSupportError, readSupportJson, requireSupportRead, requireSupportWrite } from '@/lib/support/http'
import {
  agentEscalateSenior,
  agentFileAppeal,
  agentResendPasswordEmail,
  agentResolveEscalation,
  agentSetReminder,
  buildTicketSnapshot,
  listTicketReminders,
  type AgentActionTool,
  type AgentActionResult,
} from '@/lib/ai/agent-tools'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/**
 * Read-only agent surface for the staff desk: the ticket snapshot plus its
 * scheduled reminders. Every query is keyed by the ticket, so identity never
 * comes from message text.
 */
/**
 * Maps an AgentActionResult to a response: 201 for created appeals, the
 * result's own status on failure, 200 otherwise.
 */
async function run(execute: () => Promise<AgentActionResult>) {
  const result = await execute()
  const status = result.ok ? (result.message.startsWith('Appeal filed') ? 201 : 200) : result.status
  return NextResponse.json(result, { status, headers: NO_STORE })
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireSupportRead()
  if (error) return error

  try {
    const { id } = await context.params
    const snapshot = await buildTicketSnapshot(id)
    if (!snapshot) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404, headers: NO_STORE })
    const reminders = await listTicketReminders(snapshot.ticket.publicId)
    return NextResponse.json({ snapshot, reminders, queriedBy: session.sub }, { headers: NO_STORE })
  } catch (cause) {
    return handleSupportError(cause)
  }
}

const ACTION_TOOL_NAMES = ['file_appeal', 'resend_password_email', 'set_reminder', 'escalate_senior', 'resolve_escalation'] as const

/**
 * Executes one agent action. The dispatcher is the only server entry into the
 * registry: unknown actions are rejected here, and the registry module cannot
 * even import money-moving code.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireSupportWrite()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  try {
    const { id } = await context.params
    const body = await readSupportJson(request)
    if (typeof body.action !== 'string' || !(ACTION_TOOL_NAMES as readonly string[]).includes(body.action)) {
      return NextResponse.json({ error: 'Unknown agent action.' }, { status: 400, headers: NO_STORE })
    }
    const action = body.action as AgentActionTool

    switch (action) {
      case 'file_appeal':
        return NextResponse.json(
          await run(() =>
            agentFileAppeal({
              ref: id,
              accountId: typeof body.accountId === 'string' ? body.accountId : '',
              summary: typeof body.summary === 'string' ? body.summary : '',
              context: { actorId: session.sub, request },
            }),
          ),
        )
      case 'resend_password_email':
        return NextResponse.json(
          await run(() => agentResendPasswordEmail({ ref: id, context: { actorId: session.sub, request } })),
        )
      case 'set_reminder':
        return NextResponse.json(
          await run(() =>
            agentSetReminder({
              ref: id,
              remindAt: typeof body.remindAt === 'string' ? body.remindAt : '',
              note: typeof body.note === 'string' ? body.note : undefined,
              context: { actorId: session.sub, request },
            }),
          ),
        )
      case 'escalate_senior':
        return NextResponse.json(
          await run(() =>
            agentEscalateSenior({
              ref: id,
              requestedAction: body.requestedAction as never,
              reason: typeof body.reason === 'string' ? body.reason : '',
              context: { actorId: session.sub, request },
            }),
          ),
        )
      case 'resolve_escalation':
        return NextResponse.json(
          await run(() => agentResolveEscalation({ ref: id, context: { actorId: session.sub, request } })),
        )
    }
  } catch (cause) {
    return handleSupportError(cause)
  }
}
