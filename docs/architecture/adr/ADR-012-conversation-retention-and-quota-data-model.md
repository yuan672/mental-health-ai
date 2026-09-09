# ADR-012: Conversation, Retention and Quota Data Model

- Status: Accepted
- Date: 2026-09-09

## Context

Phase 2B establishes the persistence and application-service foundations for AI
usage quotas and ordinary conversations. It does not implement an LLM provider,
AI orchestration, streaming, risk detection, user-facing conversation history, or
incognito runtime context.

Mental-health conversation content is sensitive. The persistence model must make
the ordinary-versus-incognito boundary explicit, enforce user ownership, provide a
bounded default lifetime, and support deletion without retaining message content as
an ersatz audit record. Quota consumption must remain correct under retries and
concurrent requests without Redis.

## Decision

### Phase boundary and internal services

Phase 2B provides internal `ConversationService`, `MessageService`, and
`QuotaService` application APIs with repository boundaries. It does not expose
Conversation, Message, or Quota HTTP controllers.

Phase 3 AI orchestration will call the internal message and quota services. Phase 5
will decide and expose user-facing history, save, and delete endpoints. This keeps
the Phase 2 data model from prematurely defining those product APIs.

### Ordinary and incognito persistence

The PostgreSQL `conversations` and `messages` tables represent only ordinary,
persisted conversations. They have no incognito flag or mode. Their repositories do
not accept an incognito mode.

Incognito conversation metadata and content are not written to PostgreSQL. Phase 2B
does not add a temporary-conversation port, process-memory map, Redis dependency,
incognito controller, or runtime context. Phase 3 must select the temporary context
model after its streaming, session, deployment, and multi-instance requirements are
known.

### Conversation lifetime

An ordinary conversation stores `created_at`, `expires_at`, `is_saved`, and
`deleted_at`. A new conversation is not saved and expires exactly 90 elapsed days
after its UTC creation timestamp. The calculation belongs to
`ConversationRetentionPolicy`, not controllers or repositories.

An active saved conversation has `is_saved = true` and `expires_at = NULL`. Saving
is owner-scoped and idempotent. Deleted or expired conversations cannot be saved or
restored through this primitive. Phase 2B has no unsave operation.

All business reads exclude deleted conversations and unsaved conversations whose
expiry is at or before the supplied current time. This logical expiry applies even
if physical cleanup has not run yet.

### Delete and physical cleanup

The internal delete primitive runs one transaction that marks the owner-scoped,
active conversation with `deleted_at` and immediately hard-deletes all child message
rows. Sensitive message content is therefore removed without waiting for a cleanup
schedule.

`deleted_at` is only a short-lived cleanup state, not a long-term audit record. No
seven-day, thirty-day, or permanent tombstone retention is defined. The next cleanup
run may physically delete the conversation metadata. A future `AuditLog`, designed
in its own security phase, is the correct place for authorized deletion audit
events.

A testable `purgeExpired(now, batchSize)` primitive and explicit command physically
delete expired or already-deleted conversations in bounded batches. Phase 2B does
not add an application scheduler, Redis, BullMQ, RabbitMQ, or deployment-specific
cron resource. Automatic scheduling of the command is mandatory before production
chat launch and must be connected after a deployment platform is selected.

### Messages and ordering

A message stores `id`, `conversation_id`, `role`, `sequence_number`, `content`, and
`created_at`. Roles are limited to `user` and `assistant`. Message lifetime and
ownership derive entirely from the parent conversation; messages have no separate
expiry or deletion fields.

`(conversation_id, sequence_number)` is unique. Appending a message locks the active,
owner-scoped parent conversation inside the transaction before allocating
`MAX(sequence_number) + 1`. All append paths use this lock order, so concurrent
appends to one conversation serialize and receive distinct monotonically increasing
sequence numbers. Phase 2B does not expose a message-write HTTP endpoint.

Messages do not contain diagnosis, mood, embedding, risk, provider, model, or prompt
metadata. Risk events remain a separate future safety model.

### Daily quota model

PostgreSQL is the quota source of truth. `daily_usage_quotas` contains one aggregate
per user and Asia/Shanghai calendar date, with `daily_limit` and `used_count`.
`daily_limit` is the policy snapshot established on the first successful consumption
of that day. `quota_consumptions` is an idempotency ledger with a unique constraint
on `(user_id, usage_date, idempotency_key)`.

`QuotaPolicyService` reads a validated positive `FREE_DAILY_AI_LIMIT` and the
validated `QUOTA_TIME_ZONE`. The repository does not contain a product limit
constant. Development and tests may configure 20 as a fixture, but that value is not
an accepted product policy. Phase 2B adds no plan, subscription, payment, or
enterprise schema.

`QuotaService` provides:

- `getDailyLimit(userId)`;
- `getUsage(userId)`;
- `canUseAI(userId)`;
- `consumeQuota(userId, idempotencyKey)`.

Consumption inserts the idempotency record and conditionally upserts the daily row
in one transaction. The conflict update increments only while the stored
`used_count` is below the stored `daily_limit`. PostgreSQL row locking serializes
concurrent updates. A limit failure rolls back the ledger insert; a repeated key for
the same user and date returns the existing result without consuming again. There is
no public quota-consume endpoint and no Redis cache.

### Ownership and logging

Every conversation and message repository query combines the resource identifier
with the authenticated user identifier. Missing and non-owned resources have the
same not-found application result. Quota operations never accept a target user from
an HTTP payload; future callers pass the authenticated session user.

Application events contain allowlisted metadata such as event name, user ID,
conversation ID, message ID, and role. Services and repositories never pass message
content, conversation objects, request bodies, cookies, session tokens, or CSRF
tokens to loggers. Pino redaction remains defense in depth rather than the primary
privacy boundary.

## Consequences

- Ordinary conversation persistence is explicit and bounded by default.
- Incognito data cannot accidentally be represented as a persistent conversation.
- Saved conversations remain until user deletion or account lifecycle rules apply.
- User deletion removes sensitive message content immediately while permitting a
  short cleanup transition for non-content metadata.
- Concurrent message appends have deterministic sequence allocation.
- Concurrent quota requests cannot exceed the stored daily limit, and retrying one
  logical operation is idempotent.
- Phase 3 and Phase 5 remain free to design their public and streaming APIs from
  real consumer requirements.
- Production chat launch remains blocked on connecting the cleanup command to an
  automatic deployment scheduler.

## Alternatives considered

### Persist incognito rows with a flag

Not selected because the absence of an incognito row is a stronger data-minimization
boundary than a Boolean that every future query must remember to honor.

### Add an in-process temporary store now

Not selected because Phase 2B has no AI context consumer and cannot yet decide
multi-instance routing, interruption, logout, or streaming lifetime behavior.

### Store only a daily counter

Not selected because retries could consume twice. The small idempotency ledger gives
the quota operation a stable exactly-once boundary per user, date, and operation key.

### Allocate message order with an unlocked maximum

Not selected because concurrent transactions can choose the same sequence number.
Locking the parent conversation makes allocation correct without a separate counter
service.

### Schedule cleanup inside the API process

Not selected because a deployment topology has not been chosen. An explicit,
idempotent command is portable and can later be scheduled by the selected platform.
