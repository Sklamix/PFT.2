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
Replying to a `RESOLVED` ticket reopens it to `IN_PROGRESS` and clears `resolvedAt` (the issue needs
follow-up); replying to a `CLOSED` ticket returns `409`.

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
  Requests with `Sec-Fetch-Site: cross-site` or a foreign `Origin` are rejected with `403`. Host matching uses
  the request URL host plus `NEXT_PUBLIC_APP_URL`; **`x-forwarded-host`/`x-forwarded-proto` are not trusted** and
  cannot widen the allow-list. Requests without an `Origin` (curl, server-to-server, native clients) are allowed.
- **Caching**: every Support `GET` response carries `Cache-Control: no-store`, so private conversations never
  land in a shared CDN cache.
- **Rate limits**: counters live in Postgres (`RateLimitBucket`) and are incremented with one atomic
  `INSERT … ON CONFLICT … RETURNING`. The limit is shared across serverless instances, survives cold starts and
  redeploys, and parallel bursts cannot exceed it. The in-memory map is only used in demo mode (no `DATABASE_URL`).
- **Body size**: JSON bodies above 64 KB are rejected with `413` before parsing into the domain layer.
- **Idempotency**: keys are namespaced per sender (`TRADER:<id>:<key>`, `STAFF:<id>:<key>`), so a trader and an
  agent can use the same key on one ticket without collisions or wrong "duplicate" responses. Concurrent retries
  store exactly one row (unique index remains the final guard).
- **Concurrency**: ticket updates use an optimistic `updateMany` guarded by the previously read status. A losing
  concurrent request receives `409` instead of applying an invalid transition.
- **Logging**: unexpected failures log only an error kind/Prisma code/target — never message bodies or payloads.
- **Pagination**: `page` is clamped to 1 000 and `pageSize` to 50.

## AI assistant (NVIDIA Build, Gemini fallback)

`POST /api/support/ai/chat` — trader session only, same-origin required, `Cache-Control: no-store`.

Request:

```json
{ "message": "string (2–1000 chars)", "history": [{ "role": "user|assistant", "content": "≤1000" }], "forceHandoff": false }
```

Response (answered):

```json
{ "answer": "text grounded in PFT rules", "handoff": null, "handoffReason": null }
```

Response (escalated):

```json
{ "answer": null, "handoff": { "publicId": "SUP-…", "subject": "…", "reused": true }, "handoffReason": "missing_key|quota_exhausted|rate_limited|timeout|unavailable|not_covered_by_rules|user_requested_human" }
```

- **Provider selection**: `AI_PROVIDER=nvidia|gemini` wins when set. Otherwise NVIDIA is used when `NVIDIA_API_KEY` is configured, and Gemini is the fallback. Production currently has only `GEMINI_API_KEY`, so it keeps using Gemini until the NVIDIA variables are added there on purpose. Rollback is an environment change, never a code change.
- **NVIDIA Build (NIM)**: OpenAI-compatible `POST {NVIDIA_BASE_URL}/chat/completions` (default `https://integrate.api.nvidia.com/v1`), default model `nvidia/nemotron-3.5-lightning-30b-a3b`. The key (`NVIDIA_API_KEY`) is read on the server only and never reaches the browser, logs or error payloads. `stream` is forced to `false` because NIM defaults to streaming.
- **Gemini (fallback)**: the key (`GEMINI_API_KEY`) is read on the server only; model can be overridden with `GEMINI_MODEL` (default `gemini-2.5-flash`). Requests are bounded to 7 seconds so a slow model still leaves time to create the handoff ticket.
- The prompt is grounded in rulebook v1.6 plus **live** `ChallengePricing` rows loaded per request; prices are never hardcoded. The prompt labels rows as **base fees** and explains that the checkout total adds the optional static (+15%) and frozen backup (+50%) add-ons.
- Output is a single JSON object (`answer`, `resolved`, `category`, `handoffReason`). Gemini enforces it with a response schema; NVIDIA's published ChatRequest schema does not expose `response_format`, so the JSON contract is stated in the prompt and validated server-side. Malformed, empty or truncated output is treated as unavailable and escalated — the assistant never answers from invented rules.
- Failure reasons are distinct: `quota_exhausted` (billing/quota/credit wording, or `402`), `rate_limited` (429 with retry wording), `timeout`, `unavailable` (5xx/unknown/truncated) and `missing_key` (absent, invalid or revoked key — `401`/`403`).
- Escalation reuses the trader's most recent **AI handoff** ticket (`Support chat:` subject, not CLOSED, updated within 24h) instead of opening a new one; the message is appended. Optional `idempotencyKey` makes retries safe.
- The operator receives the question, the handoff reason, the last conversation turns and server-side account context (KYC status and up to three account display IDs, statuses, sizes, phases). No secrets, prompts or credentials are included.
- `forceHandoff: true` skips the model and opens (or updates) the ticket.
- If ticket creation fails the endpoint returns `503` and explicitly does not claim a transfer.
- The assistant has no tools and cannot change accounts, balances, payouts, KYC, breaches or risk flags.
- Rate limit: 20 messages per trader per hour (Postgres-backed).
- Reliability: the browser call is bounded to **20 s** with `AbortController`; the route allows up to **30 s** on Vercel and the provider call itself is bounded to **7 s**, so the operator handoff still fits before the platform limit.
- Failures are logged as structured JSON (`event`, `reason`, provider, `status`/`code`, `model`, request correlation id) — never the API key, provider body, user message or PII. The client shows a friendly message and always clears its loading state; the UI only reports "sent to support" after the server returns a real ticket id.

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
