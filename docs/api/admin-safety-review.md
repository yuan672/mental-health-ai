# Admin Safety Review API

This document describes the Phase 6 Admin Batch 2 backend contract. It adds no
Admin UI and exposes only bounded Risk Event and Human Review Queue metadata.
Psychological message bodies, prompts, user identity, client request identifiers,
Conversation/Message/AI Turn identifiers, Incognito text, and Provider payloads
are not returned.

All routes require `ADMIN_AUTH_ENABLED=true`, an allowed `ADMIN_WEB_ORIGINS`
origin, and a current staff session. An ordinary user session or a staff principal
ID is not authorization. Every application service re-authorizes the current
staff session against the database. Mutations also require the staff CSRF cookie
and matching `x-staff-csrf-token` header.

## Permissions

The fixed `safety_reviewer` role supplies:

| Operation                                | Permission             |
| ---------------------------------------- | ---------------------- |
| list/read Risk Events and list the queue | `risk_event:read`      |
| claim a pending queue item               | `review_queue:claim`   |
| resolve the caller's claimed item        | `review_queue:resolve` |

`access_administrator` does not inherit these permissions. A role revocation or
principal disablement advances the authorization revision and invalidates old
staff sessions.

## Risk Event projection

The returned Risk Event projection is deliberately limited to:

- `id`, `level`, bounded `riskCategories` and `reasonCodes`;
- `detectionSource`, `policyVersion`, nullable classifier key/version;
- `isIncognito`, `createdAt`, and `retentionUntil`;
- `ordinaryContextReferenceAvailable`, a boolean that does not disclose a linked
  resource identifier.

The boolean is only an engineering availability hint. It is not a promise that
content access exists, and Batch 2 provides no content-reading endpoint.

## `GET /admin/risk-events`

Query parameters:

- `limit`: integer from 1 through 50, default 20;
- `cursor`: opaque cursor returned by the server;
- `level`: optional `LOW | MEDIUM | HIGH | CRITICAL`;
- `isIncognito`: optional `true | false`.

Results are ordered by `createdAt DESC, id DESC`. A cursor is bound to its filter
set; changing filters while reusing a cursor returns `400 VALIDATION_ERROR`.

## `GET /admin/risk-events/:id`

Returns the bounded Risk Event projection and its queue item when one exists.
`MEDIUM` events can validly return `reviewQueueItem: null`. A missing or already
purged Risk Event returns `404 NOT_FOUND`.

## `GET /admin/review-queue`

Query parameters:

- `limit`: integer from 1 through 50, default 20;
- `cursor`: opaque, filter-bound server cursor;
- `state`: optional `pending | in_review | resolved`;
- `priority`: optional `high | urgent`.

Queue work is ordered as urgent before high, then `createdAt ASC, id ASC`. Each row
contains a queue item and the same bounded Risk Event projection. Pagination is a
current-state traversal, not a durable queue snapshot; clients refresh after a
mutation or conflict.

## `POST /admin/review-queue/:id/claim`

Request body: `{}`.

The database condition performs exactly `pending -> in_review`, assigns the
authenticated staff principal, and sets `startedAt`. Contending reviewers cannot
both win. A missing or no-longer-pending item returns the same controlled
`409 CONFLICT` boundary.

## `POST /admin/review-queue/:id/resolve`

```json
{
  "resolutionCode": "confirmed_risk"
}
```

`resolutionCode` is one of `confirmed_risk`, `false_positive`,
`unable_to_determine`, or `action_recorded`. Only the assigned reviewer can apply
`in_review -> resolved`. Missing, non-assigned, or no-longer-in-review items return
the same controlled `409 CONFLICT` boundary.

## Atomic audit boundary

Every successful sensitive read requires a successful allowlisted Audit append in
the same short transaction. List audits record only a fixed filter category and
returned count; they do not record the selected level, Incognito value, query
object, or result data. Detail reads reference the Risk Event ID. Audit failure
returns no sensitive result.

Claim/resolve state changes and their `review_started`/`review_resolved` Audit rows
also share one transaction. Audit failure rolls the state transition back.

## Retry and unknown-result boundary

Claim and resolve are conditional state transitions, not immutable operation
receipts. If a mutation response is lost, the caller must read the authoritative
queue state before deciding what to do. A repeated claim or resolve can return
conflict because the first request already committed; a timeout is not proof of a
rollback. The current queue state and Audit history are the bounded diagnostic
record.

## Lifecycle and environment status

Risk Event retention, nullable chat-resource references, and queue cascade cleanup
remain the existing Phase 4 contracts. This batch adds no table or migration. It
does not make `SET NULL` anonymous and does not create a new content snapshot.

Production Safety Lock remains enforced, Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.
