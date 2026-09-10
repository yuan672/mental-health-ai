# Phase 2B Conversation and Quota Foundation

Phase 2B established internal application-service and repository boundaries. Phase
5A later exposed the bounded read, save, delete, quota, and capability routes
documented in `docs/api/conversation-access.md`.

## Internal services

`QuotaService` provides the current user's configured daily limit, usage, ability to
use AI, and idempotent quota consumption. PostgreSQL is the source of truth. The
daily boundary uses the configured IANA time zone, currently Asia/Shanghai. The
local/test value 20 is a fixture and is not an accepted product quota policy.

Quota aggregates remain daily, but a consumption idempotency key is unique per
user across dates. Replaying a key after the Asia/Shanghai date changes returns
the original consumption's stored-date aggregate and does not charge the new
day. Refund deletes the matching ledger row transactionally and decrements only
that original date's aggregate; it does not locate the row by the refund call's
current date.

`ConversationService` provides owner-scoped create, get, save, delete, and bounded
retention-cleanup primitives for ordinary persisted conversations. New ordinary
conversations expire after 90 days. Saved conversations have no automatic expiry.
Expired and deleted conversations are unavailable to business reads.

`MessageService` provides owner-scoped append and read primitives. Appends lock the
parent conversation inside the transaction before allocating a monotonically
increasing sequence number. Message lifetime derives from the parent conversation.

## Public-boundary history

Phase 2B intentionally did not expose HTTP routes. Phase 5A now exposes ordinary
conversation list/detail/message reads, save/delete/delete-all, quota reads, and a
minimal capability read. The following operations remain unavailable:

- creating an empty conversation directly;
- direct message append outside the AI orchestration path;
- public quota consumption;
- incognito conversation operations.

Phase 3 AI orchestration consumes the internal quota and message-write services.
Phase 5A public access remains a separate owner-scoped application boundary.

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
