# Admin Audit Read and AI Turn Metadata API

- Status: Accepted engineering contract; Batch 4A Audit Read implementation
  merged in PR #33 and Batch 4B AI Turn metadata implementation merged in PR #34
- Base paths: `/admin/audit-logs` and `/admin/ai-quality`
- Authentication: current Staff Session only
- Transport: JSON over HTTPS with `Cache-Control: private, no-store`
- Related: Accepted ADR-020 and
  `docs/architecture/phase-6-admin-audit-quality-read-design.md`

This draft supports a narrow local learning/demo Audit workflow and a metadata-only
Persistent AI Turn execution workflow. It adds no Admin UI and provides no message
content, answer scoring, clinical review, or real-model evaluation.

## 1. Common boundary

- `ADMIN_AUTH_ENABLED` must be enabled in an eligible Development/Test
  configuration. It remains false by default and cannot be used as a Production AI
  enablement switch.
- Every request requires an exact `ADMIN_WEB_ORIGINS` match and a current
  `mh_staff_session`. An ordinary `mh_session`, ordinary user ID, Staff principal ID,
  or frontend-hidden route is not authentication.
- Controller guards perform preliminary checks. The application service repeats
  database Staff Session/revision/permission authorization in the same short
  transaction as the protected read and access Audit.
- These routes are GET-only and therefore do not require a Staff CSRF header. A
  future mutation would require the existing Staff CSRF boundary and a separate
  contract.
- Query, cursor, stored projection, and response data are strictly Zod validated.
- `limit` defaults to 20 and is bounded to 1–50. A cursor is opaque and limited to
  512 characters, matching the existing shared decoder. Clients must not decode or
  construct it.
- Successful responses use the existing `{ "success": true, "data": ... }`
  envelope. Errors use the existing AppError envelope.
- No response or ordinary log contains Staff email, user ID, Conversation/Message/
  client-request ID, psychological text, Prompt text, Provider payload, cookie,
  session token, CSRF token, or raw Audit metadata.

## 2. Audit Read

### `GET /admin/audit-logs`

Permission: `audit:read`.

`access_administrator` does not inherit this permission. The endpoint exposes only
the Staff lifecycle, Knowledge workflow, Audit access, and AI-metadata access
actions listed below. It is not a general database browser.

### 2.1 Initial query

```http
GET /admin/audit-logs?limit=20&action=staff_role_revoked
```

Supported query fields:

| Field            | Contract                                                                               |
| ---------------- | -------------------------------------------------------------------------------------- |
| `limit`          | Optional integer 1–50; default 20.                                                     |
| `action`         | Optional single exact readable action.                                                 |
| `resourceType`   | Optional single exact readable resource type.                                          |
| `occurredFrom`   | Optional RFC 3339 timestamp with offset; must be paired with `occurredBefore`.         |
| `occurredBefore` | Optional exclusive RFC 3339 timestamp with offset; must be paired with `occurredFrom`. |
| `cursor`         | Opaque continuation cursor.                                                            |

The explicit interval must satisfy `occurredFrom < occurredBefore`, may span at
most 31 days, and cannot end after the server's request `observedAt`. If neither
boundary is supplied, the server uses the seven days ending at request start.
These limits do not define Audit retention. Supplying an impossible action/resource
pair returns `400 VALIDATION_ERROR` rather than an ambiguous empty result.

Readable action/resource pairs are:

| Actions                                                                                                                                                                                                                                                                                 | Resource type                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `staff_principal_bootstrapped`, `staff_principal_created`, `staff_role_granted`, `staff_role_revoked`, `staff_principal_disabled`, `staff_sessions_revoked`                                                                                                                             | `staff_principal`            |
| `staff_directory_accessed`                                                                                                                                                                                                                                                              | `staff_principal_query`      |
| `knowledge_directory_accessed`                                                                                                                                                                                                                                                          | `knowledge_article_query`    |
| `knowledge_version_status_viewed`, `knowledge_draft_viewed`, `knowledge_review_candidate_viewed`, `knowledge_publication_state_viewed`, `knowledge_draft_created`, `knowledge_draft_updated`, `knowledge_source_verified`, `knowledge_version_published`, `knowledge_version_withdrawn` | `knowledge_article_version`  |
| `audit_log_accessed`                                                                                                                                                                                                                                                                    | `audit_log_query`            |
| `ai_quality_metadata_accessed`                                                                                                                                                                                                                                                          | `ai_turn_query` or `ai_turn` |

Risk, Crisis, Mood, and Conversation Audit actions are intentionally not valid
filters and are not returned by this first endpoint. Their persistence and
retention are unchanged.

### 2.2 Response

```json
{
  "success": true,
  "data": {
    "observedAt": "2026-09-12T02:00:00.000Z",
    "period": {
      "occurredFrom": "2026-09-05T02:00:00.000Z",
      "occurredBefore": "2026-09-12T02:00:00.000Z"
    },
    "records": [
      {
        "id": "5e343d44-7a88-4ee2-88eb-c2d515ff2b82",
        "actor": {
          "type": "staff",
          "id": "f1252f6c-c49d-47ec-8e56-4c88cf3f16f0"
        },
        "action": "staff_role_revoked",
        "resource": {
          "type": "staff_principal",
          "id": "69c5b355-9eb4-4cff-bac6-afc9c48921db"
        },
        "occurredAt": "2026-09-11T09:30:00.000Z",
        "retentionUntil": "2026-12-10T09:30:00.000Z",
        "safeMetadata": {
          "roleKey": "knowledge_publisher",
          "resultingAuthorizationRevision": 4
        }
      }
    ],
    "nextCursor": null
  }
}
```

The response never returns the Audit idempotency key. Actor/resource IDs are
opaque but not anonymous, and the API does not dereference them. Actor is limited
to `{ "type": "system", "id": null }` or `{ "type": "staff", "id": "<UUID>" }`.
`safeMetadata` is the parsed action-specific shape, not the stored JSON object.

Valid metadata shapes are:

| Action category                                | Exact shape                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Staff bootstrap                                | `{ roleKey: "access_administrator" }`                                        |
| Staff creation                                 | `{}`                                                                         |
| Staff role grant/revoke                        | `{ roleKey, resultingAuthorizationRevision }`                                |
| Staff disable                                  | `{ resultingAuthorizationRevision }`                                         |
| Staff session revoke                           | `{ sessionCount }`                                                           |
| Staff directory access                         | `{ filterCategory: "all" \| "id", returnedCount }`                           |
| Knowledge directory access                     | `{ filterCategory: "all", returnedCount }`                                   |
| Knowledge status/draft/review/publication read | `{ accessCategory, version }` with the action-specific access category       |
| Knowledge draft/review mutation                | `{ disposition: "applied" \| "no_change", version, resultingDraftRevision }` |
| Knowledge publish/withdraw                     | The preceding mutation shape plus the action-specific `publicationStatus`.   |
| Audit access                                   | `{ filterCategory, pageKind, returnedCount }`                                |
| AI metadata access                             | `{ accessCategory, filterCategory, returnedCount }`                          |

An out-of-scope action is not selected. A selected row with an invalid readable
action/resource/actor/metadata combination causes controlled `500 DATABASE_ERROR`
and withholds the whole page. It is never returned as raw JSON and is not silently
rewritten.

### 2.3 Pagination and concurrent changes

Order is `occurredAt DESC, id DESC`. `nextCursor` binds the normalized filter set,
time interval, exclusive initial ceiling, and last tuple. On a continuation request,
query filters may be omitted; if supplied, they must match the cursor.

The base64url cursor is opaque to clients but is not a signed authorization token.
Every continuation therefore re-validates its canonical encoding, strict schema,
bounded time window, exclusive ceiling, readable filters, tuple, and any repeated
query fields as untrusted input. Malformed, non-canonical, schema-invalid,
out-of-bounds, or query-mismatched cursors return `400 VALIDATION_ERROR`.

This is not a durable cross-page snapshot. Ordinary later records at/after the
ceiling do not enter the traversal, while concurrent purge or a deliberately
backdated insert may change a later page. Refresh from the first page after an
operation.

Rows whose `retentionUntil <= observedAt` are unavailable even before physical
cleanup. Purge-first omits a row. Read-snapshot-first may return its complete old
projection after the access Audit commits; the response does not extend retention
or recreate the target.

### 2.4 Access Audit semantics

Every successful HTTP attempt appends exactly one required `audit_log_accessed`
record in the same short transaction. Its metadata records only a bounded filter
category, `initial | continuation`, and returned count—not actual query values.

The newly appended access row cannot enter the current traversal. A later page may
show a prior access row, but doing so triggers no automatic nested read. A database
or access-Audit failure returns no page. If commit acknowledgement is lost, an
access record may already exist; a retry is a new access and may produce another
record.

## 3. Persistent AI Turn execution metadata

### `GET /admin/ai-quality/turns`

Permission: `ai_quality:read_metadata`.

Query fields:

- optional `status=claimed|streaming|completed|failed|cancelled`;
- optional paired `createdFrom` / `createdBefore` with the same default seven-day
  and maximum 31-day rules;
- optional `limit` and opaque `cursor`.

Order is the internal `(createdAt DESC, turnId DESC)` keyset order. The cursor binds
status and the normalized time window. The response does not expose internal
pagination timestamps beyond the public `observedAt`/period.

```json
{
  "success": true,
  "data": {
    "observedAt": "2026-09-12T02:00:00.000Z",
    "period": {
      "createdFrom": "2026-09-05T02:00:00.000Z",
      "createdBefore": "2026-09-12T02:00:00.000Z"
    },
    "turns": [
      {
        "turnId": "7e44f64c-5552-4939-98ac-6cf5fa513f30",
        "status": "failed",
        "promptIdentity": {
          "availability": "available",
          "key": "supportive-chat",
          "version": "1"
        },
        "failureCategory": "provider_unavailable",
        "lifecycleStartedAt": "2026-09-11T10:00:00.000Z",
        "terminalAt": "2026-09-11T10:00:04.000Z",
        "lifecycleDurationMs": 4000,
        "leaseState": "not_applicable"
      }
    ],
    "nextCursor": null
  }
}
```

### `GET /admin/ai-quality/turns/:turnId`

Permission: `ai_quality:read_metadata`.

Returns:

```json
{
  "success": true,
  "data": {
    "observedAt": "2026-09-12T02:00:00.000Z",
    "turn": {
      "turnId": "7e44f64c-5552-4939-98ac-6cf5fa513f30",
      "status": "completed",
      "promptIdentity": {
        "availability": "available",
        "key": "grounded-supportive-chat",
        "version": "1"
      },
      "failureCategory": null,
      "lifecycleStartedAt": "2026-09-11T10:00:00.000Z",
      "terminalAt": "2026-09-11T10:00:06.000Z",
      "lifecycleDurationMs": 6000,
      "leaseState": "not_applicable"
    }
  }
}
```

A missing turn or a turn whose parent Conversation is deleted/expired returns the
same `404 NOT_FOUND`. No response explains which lifecycle event made it
unavailable.

### 3.1 Field meaning

- `turnId` is opaque and provides no linked-resource navigation.
- `promptIdentity` contains only a 1–64 character code identifier/version. The key
  matches `[a-z0-9][a-z0-9._-]*`; the version matches
  `[A-Za-z0-9][A-Za-z0-9._-]*`. Invalid historical identifiers produce
  `{ "availability": "unavailable" }`.
- `failureCategory` is the server's bounded mapping; the persisted raw failure code
  is never returned. Unknown or status-inconsistent raw values map to `unknown`.
  A failed/cancelled row with no code also maps to `unknown`; a consistent
  non-failure row returns null.
- `lifecycleStartedAt` is the claim/lifecycle start, not Provider dispatch.
- `lifecycleDurationMs` is the complete persisted turn lifecycle, not model/network
  latency.
- An active row always projects `terminalAt=null` and `lifecycleDurationMs=null`,
  even if malformed historical data contains a terminal timestamp. A terminal row
  projects its terminal timestamp and duration only when that timestamp is valid
  and not earlier than `lifecycleStartedAt`; otherwise both fields are null.
- `leaseState` is `valid` or `expired` only for active rows and
  `not_applicable` for terminal rows. The raw lease timestamp is not returned.
- `completed` indicates backend terminal persistence, not proof that an SSE
  completion reached the browser.

The endpoint never returns user, Conversation, Message, client-request, Risk,
Quota, citation, retrieval, Provider, model, token, TTFT, finish-reason, or content
data. It never queries operational logs to fill missing fields.

### 3.2 Visibility and deletion

Only Persistent `ai_turns` rows whose parent Conversation is active at
`observedAt` are eligible. Soft-deleted and expired-unsaved Conversations are
excluded before physical purge. Hard purge cascades the turn; the endpoint creates
no independent copy.

Incognito has no `ai_turns` row and cannot appear. The service must not join Risk,
Audit, logs, or in-memory execution state to reconstruct Incognito history.

The reader can inspect retained metadata while AI generation or Knowledge
augmentation is disabled. Reading does not enable AI, call a Provider, consume
quota, or change Consent/Safety behavior.

### 3.3 Access Audit

Each successful list/detail appends one required
`ai_quality_metadata_accessed` record in the same short transaction as
authorization and projection. It contains only list/detail, a bounded filter
category, and returned count. It does not copy turn state, prompt identity,
failure category, or timestamps into Audit metadata.

Audit append or commit failure withholds all metadata. A retry after an unknown
commit acknowledgement is a new access and may create another Audit record.

## 4. Error contract

| Condition                                                         | Result                                  |
| ----------------------------------------------------------------- | --------------------------------------- |
| Invalid ID, time range, filter, cursor, or cursor/filter mismatch | `400 VALIDATION_ERROR`                  |
| Missing/invalid Staff Session                                     | `401 UNAUTHENTICATED`                   |
| Wrong role, forged context, or untrusted Admin Origin             | `403 FORBIDDEN`                         |
| Missing/deleted/expired AI Turn detail                            | `404 NOT_FOUND`                         |
| Admin backend disabled                                            | `503 ADMIN_AUTH_DISABLED`               |
| Query, projection, required Audit append, or commit failure       | `500 DATABASE_ERROR`; no protected data |

## 5. Client integration notes

- A replacement Admin client must treat every cursor as opaque and discard pages
  on Session invalidation or role revision change.
- It must not cache these responses in browser persistent storage or analytics.
- A network error does not prove whether the access Audit committed. Retrying is a
  new audited access.
- Empty results are not proof that historical data never existed; retention,
  deletion, filtering, and environment state may make it unavailable.
- No client may reinterpret AI Turn metadata as answer quality, clinical safety,
  real-model accuracy, or user delivery confirmation.

No client implementation is included in this batch.

## 6. Batch 4A implementation evidence

The Batch 4A implementation provides `GET /admin/audit-logs` with the strict
allowlisted projection, transaction-bound database reauthorization, required
access Audit, bounded time/cursor validation, retention filtering, and PostgreSQL
snapshot ordering described above. It adds no Schema or Migration.

A local `_test`-database plan review used 30,000 synthetic Audit rows and the
maximum page read (`limit + 1 = 51`). Representative unfiltered, action,
resource, combined, and continuation queries completed in approximately
6.1–12.0 ms on the development machine. This is bounded local evidence, not a
production performance guarantee; no index Migration is justified for this
local learning/demo batch. Production query-plan and workload validation remains
separate readiness work.

## 7. Batch 4B implementation evidence

The Batch 4B implementation provides `GET /admin/ai-quality/turns` and
`GET /admin/ai-quality/turns/:turnId` with the strict metadata-only projection,
transaction-bound database reauthorization, required access Audit, bounded
time/cursor validation, parent-Conversation visibility rule, and PostgreSQL
snapshot ordering described above. It adds no Schema or Migration.

The review hardening establishes `observedAt` only after transaction-bound Staff
authorization and uses that one value for Conversation expiry, lease projection,
the initial window, response, and access Audit. Continuations retain their original
cursor window while receiving a new request `observedAt`. Unknown stored failure
codes—including names inherited from the JavaScript object prototype—map to the
bounded `unknown` category. Ordinary and error-log paths collapse the complete
AI-turn detail path family to one fixed route shape without retaining a target ID,
query, or extra suffix.

A local `_test`-database plan review temporarily added 30,000 synthetic
Conversations and AI Turns inside one transaction, analyzed the resulting tables,
and then rolled the transaction back. The maximum list read (`limit + 1 = 51`)
completed in approximately 18.4 ms without a status filter, 8.4 ms with a status
filter, and 15.1 ms for a continuation query; the detail lookup completed in
approximately 0.06 ms. This is bounded local learning/demo evidence, not a
production performance guarantee. The unfiltered list plans use sequential scans
and a top-N sort, but the measured bounded workload does not justify a speculative
index Migration in this batch. Production query-plan and workload validation
remains separate readiness work.

## 8. Preserved state

- `ADMIN_AUTH_ENABLED=false` by default.
- `AI_KNOWLEDGE_ENABLED=false` by default.
- Production Safety Lock: Enforced.
- Production AI Chat: Disabled.
- `productionSafe=false`.
- Real Model Safety Evaluation: Not Evaluated.
- The three candidate articles remain unverified and unpublished.
- Phase 5E and Phase 6 remain incomplete.
