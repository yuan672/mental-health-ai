# Phase 2B Conversation and Quota Foundation

Phase 2B adds internal application-service and repository boundaries. It does not
add public HTTP routes.

## Internal services

`QuotaService` provides the current user's configured daily limit, usage, ability to
use AI, and idempotent quota consumption. PostgreSQL is the source of truth. The
daily boundary uses the configured IANA time zone, currently Asia/Shanghai. The
local/test value 20 is a fixture and is not an accepted product quota policy.

`ConversationService` provides owner-scoped create, get, save, delete, and bounded
retention-cleanup primitives for ordinary persisted conversations. New ordinary
conversations expire after 90 days. Saved conversations have no automatic expiry.
Expired and deleted conversations are unavailable to business reads.

`MessageService` provides owner-scoped append and read primitives. Appends lock the
parent conversation inside the transaction before allocating a monotonically
increasing sequence number. Message lifetime derives from the parent conversation.

## No public Phase 2B routes

The following routes are intentionally not implemented in Phase 2B:

- conversation history/list/detail;
- conversation save or delete;
- message append or history;
- quota reads or consumption;
- incognito conversation operations.

Phase 3 AI orchestration will consume the internal quota and message-write services.
Phase 5 will define user-facing conversation history, save, and delete APIs.

## Incognito boundary

The persistent schema represents ordinary conversations only. Incognito metadata
and content are not stored in PostgreSQL. Phase 2B does not select or implement a
temporary runtime store. That decision is deferred until Phase 3 has concrete
streaming, session, deployment, and multi-instance requirements.

## Retention command

Run the cleanup primitive explicitly with:

```bash
pnpm data:purge-conversations
```

The command removes expired records and deleted metadata in bounded batches. It is
not a substitute for production scheduling. Automatic scheduling is required before
production chat launch, after the deployment platform is selected.
