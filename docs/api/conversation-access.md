# Phase 5A Conversation Access API

Phase 5A exposes authenticated access to ordinary persisted conversations. It does
not expose Incognito lifecycle operations, message writes, AI-turn records, provider
metadata, or safety records.

## Routes

| Method | Path                          | Authentication | CSRF                         |
| ------ | ----------------------------- | -------------- | ---------------------------- |
| GET    | `/conversations`              | Session cookie | None (read-only)             |
| GET    | `/conversations/:id`          | Session cookie | None (read-only)             |
| GET    | `/conversations/:id/messages` | Session cookie | None (read-only)             |
| POST   | `/conversations/:id/save`     | Session cookie | Origin + double-submit token |
| DELETE | `/conversations/:id`          | Session cookie | Origin + double-submit token |
| DELETE | `/conversations`              | Session cookie | Origin + double-submit token |
| GET    | `/quota`                      | Session cookie | None (read-only)             |
| GET    | `/capabilities`               | Session cookie | None (read-only)             |

All conversation and message queries bind the authenticated user ID in the data
query. Missing, expired, deleted, and non-owned resources use the same `404`
response. Clients cannot supply a trusted user ID.

Sensitive conversation, message, and quota responses set
`Cache-Control: private, no-store`. The capability response contains only the
public `aiChatEnabled` boolean and sets `Cache-Control: no-store`. JSON error
responses also set `Cache-Control: private, no-store`, including authentication and
owner-scoped `404` failures.

## Conversation history

`GET /conversations` accepts optional `limit` and `cursor` query parameters. The
default limit is 20 and the maximum is 100. Results are ordered by
`created_at DESC, id DESC`. The cursor is a validated, versioned opaque token; it is
not an authorization mechanism.

The response contains only:

```json
{
  "success": true,
  "data": {
    "conversations": [
      {
        "id": "00000000-0000-4000-8000-000000000000",
        "createdAt": "2026-09-10T08:00:00.000Z",
        "expiresAt": "2026-12-09T08:00:00.000Z",
        "isSaved": false
      }
    ],
    "nextCursor": null
  }
}
```

No message preview, generated title, Risk Event, AI Turn, provider/model, or safety
metadata is returned.

## Conversation detail and messages

`GET /conversations/:id` returns the same minimal conversation metadata.

`GET /conversations/:id/messages` uses a versioned opaque sequence cursor. It
selects the newest bounded page and returns the messages in ascending sequence order
within that page. Each message contains only `id`, `role`, `content`, `sequence`,
and `createdAt`.

## Save and delete lifecycle

Saving is owner-scoped and idempotent. It sets `isSaved=true` and
`expiresAt=null`; an expired conversation cannot be revived.

Single deletion transactionally marks the Conversation deleted, immediately
hard-deletes its Message content, and appends one allowlisted user Audit Log entry.
Delete-all applies the same operation as one set-based transaction to every
not-yet-purged ordinary conversation owned by the user, including saved and expired
conversations, and writes one aggregate audit entry. Risk Event and Audit retention
remain independent from ordinary chat-history deletion.

The delete-all response uses the server-computed transaction result; the browser
must not estimate it from the currently loaded history page:

```json
{
  "success": true,
  "data": { "deleted": true, "conversationCount": 3 }
}
```

The browser must not persist chat bodies in `localStorage` or IndexedDB. This API
does not provide a public Incognito lifecycle; that remains a later Phase 5 scope.

## Quota and capabilities

`GET /quota` exposes only `dailyLimit`, `used`, `remaining`, and `usageDate` for the
authenticated user. The limit remains configuration-driven; the test value 20 is
not an accepted production product policy.

`GET /capabilities` exposes only:

```json
{
  "success": true,
  "data": {
    "aiChatEnabled": false
  }
}
```

It does not disclose `productionSafe`, readiness blockers, classifier/provider
health, credentials, or internal feature flags. Production Safety Lock behavior is
unchanged.

## Error contract

All failures continue to use the shared error response documented in
`docs/api/error-format.md`. Malformed cursors and limits are safe validation errors;
stack traces, database errors, private content, and internal identifiers are not
returned.
