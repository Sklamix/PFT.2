# PFT Support API — Stage 1 (backend foundation)

Ticket IDs in URLs are **public references** (`SUP-XXXXXXXXXX`). Internal ids are accepted as a fallback but
never grant access on their own: every query is scoped to the authenticated trader or to staff roles.

## Errors

All errors use the existing PFT shape:

```json
{ "error": "Human readable message" }
```

| Status | Meaning |
|---|---|
| 400 | validation / unsupported value / no supported fields |
| 401 | missing or invalid session |
| 403 | role cannot perform this operation |
| 404 | ticket not found **or not owned by the caller** (indistinguishable by design) |
| 409 | invalid status transition, closed ticket, unsettled state |
| 429 | rate limit exceeded |
| 500 | generic failure (details only in server logs) |

## Pagination

`?page=1&pageSize=20` (pageSize max 50). List responses:

```json
{ "items": [], "page": 1, "pageSize": 20, "total": 0 }
```

Messages are returned oldest-first; ticket lists are newest-activity-first (`updatedAt desc`).

## Trader endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/api/support/tickets` | body `{ subject, category, body }`; status/priority/assignee are server-decided; 10 tickets/hour |
| GET | `/api/support/tickets` | own tickets; `status` filter |
| GET | `/api/support/tickets/[id]` | own ticket + paginated messages; staff names are hidden |
| POST | `/api/support/tickets/[id]/messages` | body `{ body, idempotencyKey? }`; 60 messages / 10 min |

**Idempotency:** send `idempotencyKey` (8–100 chars `[A-Za-z0-9:_-]`). A retry with the same key returns the
original message with `duplicate: true` and HTTP 200 instead of creating a second row.

Trader messages are rejected with `409` on `CLOSED` tickets. A message on a `RESOLVED` or `WAITING_FOR_USER`
ticket moves it back to `WAITING_FOR_STAFF`.

## Staff endpoints

| Method | Path | Allowed roles |
|---|---|---|
| GET | `/api/admin/support/tickets` | ADMIN, SUPPORT, RISK_MANAGER (read-only) |
| GET | `/api/admin/support/tickets/[id]` | ADMIN, SUPPORT, RISK_MANAGER |
| POST | `/api/admin/support/tickets/[id]/messages` | ADMIN, SUPPORT |
| PATCH | `/api/admin/support/tickets/[id]` | ADMIN, SUPPORT |

List filters: `status`, `priority`, `category`, `assignedTo=me|unassigned|<staff id>`, `sort=updated|priority`.

PATCH accepts **only** `status`, `priority`, `assignedToId`; any other field is ignored and a body with no
supported field returns `400` (no mass assignment). `SUPPORT` may assign only to itself or unassign;
`ADMIN` may assign any staff member. Assigning a trader is rejected (`400`).

A staff reply moves `OPEN` / `IN_PROGRESS` / `WAITING_FOR_STAFF` tickets to `WAITING_FOR_USER`.

## Status transitions

```
OPEN               → IN_PROGRESS | WAITING_FOR_USER | WAITING_FOR_STAFF | RESOLVED | CLOSED
IN_PROGRESS        → OPEN | WAITING_FOR_USER | WAITING_FOR_STAFF | RESOLVED | CLOSED
WAITING_FOR_USER   → OPEN | IN_PROGRESS | WAITING_FOR_STAFF | RESOLVED | CLOSED
WAITING_FOR_STAFF  → OPEN | IN_PROGRESS | WAITING_FOR_USER | RESOLVED | CLOSED
RESOLVED           → IN_PROGRESS | WAITING_FOR_USER | WAITING_FOR_STAFF | CLOSED
CLOSED             → IN_PROGRESS
```

Re-sending the current status is a no-op (retry-safe). Any other transition returns `409`.

`RESOLVED` sets `resolvedAt`; `CLOSED` sets `closedAt`; reopening to `IN_PROGRESS` clears `closedAt`.

## UI notes (Stage 2)

The admin desk can assign a ticket **to the signed-in agent** or unassign it. There is no staff-directory
endpoint yet, so assigning an arbitrary colleague from the UI is intentionally not offered. An `ADMIN` can
still call `PATCH` with any staff id; adding a `GET /api/admin/staff` (id/name/email/role) would let the UI
offer a proper assignee picker.

The trader UI displays staff messages as **PFT Support** (the API does not expose staff identity to traders).

## Security hardening (Stage 3)

- **CSRF**: all state-changing Support endpoints run `assertSameOrigin` (`lib/security/csrf.ts`).
  Requests with `Sec-Fetch-Site: cross-site` or a foreign `Origin` are rejected with `403`. Requests without
  an `Origin` (curl, server-to-server, native clients) are allowed — they cannot be triggered by another site
  with the user's cookies. `SameSite=Lax` remains as defence in depth.
- **Body size**: JSON bodies above 64 KB are rejected with `413` before parsing into the domain layer.
- **Idempotency**: keys are namespaced per sender (`TRADER:<id>:<key>`, `STAFF:<id>:<key>`), so a trader and an
  agent can use the same key on one ticket without collisions or wrong "duplicate" responses. Concurrent retries
  store exactly one row (unique index remains the final guard).
- **Concurrency**: ticket updates use an optimistic `updateMany` guarded by the previously read status. A losing
  concurrent request receives `409` instead of applying an invalid transition.
- **Logging**: unexpected failures log only an error kind/Prisma code/target — never message bodies or payloads.
- **Pagination**: `page` is clamped to 1 000 and `pageSize` to 50.

## Audit

Staff actions are written to `AuditLog` via `recordActivity`:

- `SUPPORT_TICKET_REPLIED`
- `SUPPORT_TICKET_STATUS_CHANGED`
- `SUPPORT_TICKET_PRIORITY_CHANGED`
- `SUPPORT_TICKET_ASSIGNED`

Trader actions (`TRADER_SUPPORT_TICKET_CREATED`, `TRADER_SUPPORT_MESSAGE_SENT`) appear in the trader
activity log. Metadata stores ticket reference, category and message length only — never message bodies.

## Migration

```bash
# after review, against the target database (dev or prod):
npx prisma db execute --file prisma/sql/support-tickets.sql --schema prisma/schema.prisma
```

The script is idempotent: enums, tables, indexes and foreign keys are created only when missing.
