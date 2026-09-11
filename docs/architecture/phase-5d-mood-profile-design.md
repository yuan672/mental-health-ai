# Phase 5D — Mood / Profile Design Review

- Status: Design pending review
- Baseline: `develop` at `0655c18b1b230ad5463fb75e54ab9167eb0a930f`
- Proposed architecture: ADR-017
- Product scope: Approved for contract finalization on 2026-09-11
- Implementation status: Not started

This document defines the bounded Phase 5D product and engineering proposal. It
does not implement application code, schema, migrations, or tests and does not
start Phase 5E or Phase 6.

## 1. Existing capabilities to reuse

- server-side opaque-session authentication and centralized browser invalidation;
- authenticated Nest guards and Origin plus double-submit CSRF protection;
- owner-scoped repositories and uniform not-found behavior;
- validated, versioned opaque cursor pagination;
- PostgreSQL/Drizzle forward-only migration workflow and protected test databases;
- the shared AppError envelope and Zod request/response validation;
- `private, no-store` authenticated responses and request-body log redaction;
- React Router protected application shell, unified `apiClient`, in-memory state,
  responsive navigation, accessible confirmation dialog, and session-expiry cleanup;
- Vitest/RTL, Jest/Supertest, PostgreSQL integration tests, and Chromium P0.

There is currently no Mood module, Mood table, Profile table, Profile endpoint, or
Mood UI. The existing `users` table contains only ID and creation time;
`password_credentials` owns the normalized email and `age_verifications` owns the
minimal successful adult-verification result.

## 2. Recommended product decisions

| Question        | Recommendation                                                         | Main alternative                    | Impact                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Score           | Required integer 1–5: 很低落、较低落、一般、较好、很好                 | 0–10                                | Five choices are easier to scan and must not be presented as a validated clinical instrument.                                                                                                                      |
| Emotion         | Optional one primary bounded option                                    | Multi-select or free text           | A single optional choice keeps the first trend and form accessible; the note carries nuance.                                                                                                                       |
| Emotion options | 愉快、平静、有希望、一般、疲惫、有压力、难过、生气、不堪重负           | Shorter positive/negative-only list | The stored codes are `joyful`, `calm`, `hopeful`, `neutral`, `tired`, `stressed`, `sad`, `angry`, and `overwhelmed`. These are everyday descriptions, not diseases; no score/emotion consistency rule is inferred. |
| Note            | Optional, trimmed, maximum 500 Unicode code points                     | Longer journal entry                | Enough for a short check-in while limiting sensitive-data collection and UI/logging exposure. Empty text normalizes to `null`.                                                                                     |
| Entries per day | Multiple                                                               | One row per day                     | Mood can change; a daily uniqueness rule would overwrite or misrepresent a second check-in.                                                                                                                        |
| Backfill        | Not in first implementation                                            | User-selected occurrence date/time  | Server receipt time is unambiguous. Backdating needs a distinct `occurredAt` model and timezone UX.                                                                                                                |
| Edit            | Score, emotion, and note only                                          | Also edit timestamp                 | Preserve the original server receipt time. Updates increment a revision.                                                                                                                                           |
| Delete          | Per-entry and delete-all hard deletion plus content-free audit actions | Soft delete                         | Records outlive the 30-day UI window, so delete-all must also cover older hidden rows. Do not retain a sensitive note in a tombstone.                                                                              |
| Trend           | Daily count and average over a fixed 7/30-day calendar range           | Latest entry only                   | An average represents multiple check-ins without pretending missing dates are zero. It is labelled as a simple summary of recorded entries.                                                                        |
| Profile         | Read-only existing account facts; no new columns                       | Add display name/avatar             | Current product has no use case that justifies collecting new personal fields.                                                                                                                                     |

The recommendation changes no Accepted ADR. It is captured in Proposed ADR-017
because retention, non-AI processing, retry semantics, date boundaries, and Profile
data minimization are durable decisions.

## 3. Mood user flow

### Check-in

1. The authenticated user opens `/app/mood`.
2. The page loads the current seven-day history and trend.
3. The user selects a 1–5 score, may select one emotion, and may enter a short note.
4. The client creates one UUID `clientRequestId` for that explicit submission.
5. While the request is pending, a second submission is disabled.
6. Success adds the server-returned entry, refreshes the trend, clears the form, and
   announces completion without moving focus unexpectedly.
7. A definitely rejected request keeps the draft for correction.
8. A network-unknown result keeps the request values and `clientRequestId` in memory
   and calls the read-only creation-status endpoint. If the row exists, the UI uses
   its current server state. If absent, it does not POST the old request again;
   creating a record requires a new explicit action and a new ID.

The page does not autosave a draft and does not persist it in browser storage.

### History and trend

- The initial view is seven days; the user may choose thirty days.
- Range controls are real buttons or tabs with programmatic selected state.
- A chart or compact trend list uses local dates and is paired with textual values;
  color is never the only carrier of score.
- Days without entries are shown as gaps/“未记录”, not zero.
- Multiple entries remain individually visible newest first. The daily point is the
  arithmetic mean and displays its entry count.
- “Load more” keeps the initial calendar range and creation-time ceiling. It does
  not claim a point-in-time snapshot across pages; edits, deletes, or a late commit
  can require a first-page refresh.
- The empty state invites a check-in and makes no claim about the user's wellbeing.

### Edit

- An entry action opens a labelled form populated from current server data.
- The request replaces all three editable fields and carries `expectedRevision`.
- Success updates the entry and trend from the server response.
- A stale revision (`MOOD_STATE_CHANGED`) reloads authoritative data and asks for a
  new explicit edit; it does not silently overwrite another tab.
- A network-unknown result does not auto-retry. The UI reloads the entry/range and
  explains that the submitted result could not be confirmed.

### Delete

- Delete opens the existing accessible confirmation dialog.
- The copy says that this mood entry will be removed and cannot be restored. It does
  not promise immediate removal from backups or unrelated audit retention.
- The request carries the displayed revision. Success removes only the server-
  confirmed entry and refreshes the trend.
- If another tab updated the entry first, deletion receives a conflict and requires
  review of the latest entry before a new confirmation.
- If another request already removed it, the UI reloads and says the entry is no
  longer present; it does not claim which request deleted it.

Delete-all uses a separate confirmation that says all Mood records are included,
not only the visible seven/thirty-day range. The UI does not calculate the result
from loaded pages; it shows the server's actual `entryCount`. A network-unknown
delete-all result is never automatically retried because doing so could delete a
new check-in created after the original request. The page reloads authoritative
history, then requires a new explicit confirmation.

### Interaction states

| State                   | Presentation and allowed action                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Initial loading         | Skeleton/plain loading text with `aria-busy`; form may wait for session/profile bootstrap but not AI capability.                     |
| Empty                   | Non-diagnostic invitation to record a current check-in.                                                                              |
| Submitting              | One active request, controls remain readable, duplicate submit disabled.                                                             |
| Validation failure      | Field-associated text via `aria-describedby`; focus the first invalid field.                                                         |
| Definite server failure | Preserve editable draft; allow a new explicit attempt.                                                                               |
| Create result unknown   | Preserve request ID and values in memory; use read-only confirmation. An absent result requires a new explicit create with a new ID. |
| Update/delete unknown   | Reload authoritative state; never auto-retry a destructive request or claim which request changed the row.                           |
| Stale revision          | Refresh and require a new edit/delete decision.                                                                                      |
| Delete confirmation     | Focus trapped, Escape supported while idle, destructive action named, focus restored.                                                |

On mobile, the form and history are single-column, controls have adequate touch
targets, text wraps, and the action menu/dialog remains keyboard complete. On
desktop, the check-in card and history may share the available content width but do
not create a separate dashboard framework.

## 4. Mood data model

Proposed table `mood_entries`:

| Column              | Type                  | Rule                                                          |
| ------------------- | --------------------- | ------------------------------------------------------------- |
| `id`                | uuid                  | Server-generated primary key.                                 |
| `user_id`           | uuid                  | Required FK to `users.id`, `ON DELETE CASCADE`.               |
| `client_request_id` | uuid                  | Required creation-idempotency boundary.                       |
| `mood_score`        | integer               | Required, database check 1–5.                                 |
| `emotion`           | varchar(32) nullable  | Application/Zod bounded code; no diagnostic label.            |
| `note`              | varchar(500) nullable | Trimmed; empty becomes null; maximum 500 Unicode code points. |
| `state_revision`    | integer               | Starts at 1 and remains positive.                             |
| `created_at`        | timestamptz           | Server-owned, immutable.                                      |
| `updated_at`        | timestamptz           | Server-owned; must not precede `created_at`.                  |

Indexes and constraints:

- unique `(user_id, client_request_id)`;
- index `(user_id, created_at, id)` for range and cursor reads;
- score, revision, note-length, and timestamp-order checks;
- no local-date, derived trend, diagnosis, risk, AI, deleted, or expiry columns.

After trimming leading/trailing whitespace, Web and API count Unicode code points
with code-point iteration, not JavaScript UTF-16 `.length`, bytes, or grapheme
clusters. PostgreSQL `varchar(500)` and an explicit `char_length(note) <= 500` check
apply the same limit. Chinese characters and a simple emoji each count as one;
multi-code-point emoji sequences and combining sequences count by their constituent
code points. The UI counter is informative, while API and database validation remain
authoritative.

The table is separate from Conversation, Message, RiskEvent, and Profile. User
deletion cascading the table is only the database lifecycle relationship; production
account deletion, backup deletion, and retention wording remain unapproved.

## 5. Time and trend calculation

`MoodDateRangePolicy` owns the Asia/Shanghai boundary and a testable Clock. For
`days=7`, the interval is `[00:00 today-6 days, 00:00 tomorrow)` in Asia/Shanghai;
`days=30` uses today-29 days. The boundaries are converted to UTC before querying.
The first page also records a `createdAtCeiling` equal to the service Clock's current
instant, bounded by the range end.

The cursor contains a version, kind, selected range, frozen UTC start/end,
`createdAtCeiling`, last `createdAt`, and last ID. Subsequent pages must match the
requested range and reuse those predicates, so crossing midnight cannot change from
one calendar window to another. A malformed, non-canonical, or mismatched cursor is
a validation error.

The ceiling is a query bound, not a transaction snapshot. It does not freeze a
later edit or deletion. A create assigned an earlier timestamp but committed after
the first request is eligible, although its keyset position can mean that it only
appears after a refresh. Each HTTP response obtains its entry page and complete
daily trend in one short read-only, repeatable-read transaction so those two pieces
agree for that response. No database transaction spans pagination requests, and
cross-page results do not promise a complete historical snapshot. Create, update,
or delete success always refreshes page one and the trend.

Daily summaries group with the same Asia/Shanghai date interpretation and return:

```json
{
  "localDate": "2026-09-11",
  "entryCount": 2,
  "averageScore": 3.5
}
```

Only dates with entries are returned. The client derives missing display dates from
the explicit period and never interprets absence as a mood value. There is no
persisted aggregate, prediction, score classification, or health interpretation.

## 6. Public API proposal

All routes require the server-side session. GET responses and errors are private/no-
store. POST/PATCH/DELETE use the existing CSRF guard. The authenticated user ID is
never accepted from a request body.

| Method   | Path                                             | Purpose                                                              |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `POST`   | `/mood-entries`                                  | Create once or resolve an existing live creation key.                |
| `GET`    | `/mood-entries?days=7\|30&limit=&cursor=`        | Bounded-window entries plus daily trend.                             |
| `GET`    | `/mood-entries/creation-status/:clientRequestId` | Read-only confirmation of a currently existing create result.        |
| `GET`    | `/mood-entries/:id`                              | Owner-scoped authoritative entry for reconciliation.                 |
| `PATCH`  | `/mood-entries/:id`                              | Replace editable fields at an expected revision.                     |
| `DELETE` | `/mood-entries/:id`                              | Hard-delete at an expected revision.                                 |
| `DELETE` | `/mood-entries`                                  | Hard-delete every owned Mood row, including records outside 30 days. |
| `GET`    | `/profile`                                       | Read existing minimal account facts.                                 |

History uses the existing pagination defaults: `limit=20`, bounded to 1–100. The
shared schemas reject unknown fields. Validation and cursor errors use the existing
HTTP 400 `VALIDATION_ERROR`; missing authentication uses 401, CSRF rejection uses
403, missing/non-owned resources use 404, and stale revisions use 409
`MOOD_STATE_CHANGED`. No error includes a submitted score, emotion, or note.

### Create request and response

```json
{
  "clientRequestId": "00000000-0000-4000-8000-000000000000",
  "moodScore": 3,
  "emotion": "stressed",
  "note": "今天有些忙，想先休息一下。"
}
```

```json
{
  "success": true,
  "data": {
    "entry": {
      "id": "00000000-0000-4000-8000-000000000001",
      "moodScore": 3,
      "emotion": "stressed",
      "note": "今天有些忙，想先休息一下。",
      "stateRevision": 1,
      "createdAt": "2026-09-11T04:00:00.000Z",
      "updatedAt": "2026-09-11T04:00:00.000Z"
    },
    "disposition": "created"
  }
}
```

While the row exists, a repeated ID returns `disposition: "existing"` and the
entry's current state. A buggy same-ID/different-payload request applies none of the
new fields. Because an intervening edit may have changed the row, `existing` is not
an immutable receipt of the original create payload. The server stores neither a
payload copy nor a sensitive note fingerprint.

### Read-only create confirmation

An unknown POST result is checked without another create mutation:

```json
{
  "success": true,
  "data": {
    "status": "present",
    "entry": {
      "id": "00000000-0000-4000-8000-000000000001",
      "moodScore": 4,
      "emotion": "calm",
      "note": null,
      "stateRevision": 2,
      "createdAt": "2026-09-11T04:00:00.000Z",
      "updatedAt": "2026-09-11T04:10:00.000Z"
    }
  }
}
```

The response is a strict discriminated union:
`{ status: "present", entry } | { status: "absent" }`. The `entry` is the current
row and may reflect a later edit. If no owned live row matches, the endpoint returns
`absent` with no `entry`. It deliberately does not claim whether the original
request never committed or the row was later hard-deleted. The endpoint never
creates or restores data. Cross-user keys are isolated and indistinguishable from
absent.

### History response

```json
{
  "success": true,
  "data": {
    "days": 7,
    "timeZone": "Asia/Shanghai",
    "period": {
      "startDate": "2026-09-05",
      "endDate": "2026-09-11"
    },
    "entries": [],
    "dailyTrend": [],
    "nextCursor": null
  }
}
```

Entries contain only the public entry fields above. The cursor is opaque. It
contains no score, emotion, or note.

### Update

```json
{
  "expectedRevision": 1,
  "moodScore": 4,
  "emotion": "calm",
  "note": null
}
```

The complete replacement avoids ambiguous patch/null semantics. A changed update
increments the revision and updates `updatedAt`; an exact no-change update returns
the current row without incrementing. A stale revision returns HTTP 409 with
`MOOD_STATE_CHANGED`.

### Delete

```json
{
  "expectedRevision": 2
}
```

Success returns `{ "success": true, "data": { "deleted": true } }`. Missing and
non-owned IDs share `404 NOT_FOUND`. A current owned row with a different revision
returns `409 MOOD_STATE_CHANGED`.

Delete-all returns
`{ "success": true, "data": { "deleted": true, "entryCount": 12 } }`, where the
count comes from the transactional database result rather than loaded UI history.
The transaction appends one content-free audit action and commits both effects or
neither. A repeated explicit delete-all after success returns `entryCount: 0`.

The existing application-level Audit allowlists gain only:

| Action                 | Resource type  | Resource ID | Idempotency key                              | Safe metadata                            |
| ---------------------- | -------------- | ----------- | -------------------------------------------- | ---------------------------------------- |
| `mood_entry_deleted`   | `mood_entry`   | Entry ID    | `mood_entry_deleted:<userId>:<entryId>`      | `{}`                                     |
| `mood_history_deleted` | `mood_history` | User ID     | `mood_history_deleted:<userId>:<serverUuid>` | `{ entryCount }` with a positive integer |

The database continues to store Audit action/resource values as text, while Zod
provides the bounded allowlists and action-specific metadata schema. A delete-all
that removes zero rows returns `entryCount: 0` and does not create a meaningless
audit row. Audit insertion and deletion share the Mood repository transaction;
failure of either rolls back both. These actions do not change Audit read
authorization and never include score, emotion, note, or trend.

### Profile response

```json
{
  "success": true,
  "data": {
    "email": "user@example.com",
    "accountCreatedAt": "2026-09-09T08:00:00.000Z",
    "adultEligibility": {
      "verified": true,
      "verifiedAt": "2026-09-09T08:00:00.000Z"
    }
  }
}
```

The endpoint returns neither an internal user/session ID nor age-provider method or
evidence. It is separate from `/auth/session`, so root session bootstrap does not
load account PII into every route.

## 7. Ownership, retry, and concurrency

### Create

- UI button state reduces accidental double-clicks, while the database unique key
  provides the real guarantee.
- Concurrent same-user/same-ID creates converge on one row. The winner returns
  `created`; a loser re-queries after the unique conflict and returns `existing`.
- The same ID for different users is independent.
- Same-ID/different-payload never updates the existing row; the new payload is
  ignored and the current row is returned.
- If that row was edited, the returned current state can differ from the original
  create body and is not described as an immutable create receipt.
- No content hash or creation-operation ledger is added.

The read-only creation-status route is the supported unknown-result path. A
`present` result confirms only that a live row currently owns the key. An `absent`
result cannot distinguish never-created from hard-deleted, so the UI offers no
“retry old request” mutation. A user who still wants to record the draft performs a
new explicit create with a new ID.

### Update/update race

Both requests use the same revision. One conditional update wins and increments it;
the other receives `MOOD_STATE_CHANGED`. It must refresh before a new choice.

### Update/delete race

Writes use a consistent owner/id row lock or equivalent conditional transaction:

- delete first: update sees no owned row and returns not found;
- update first: delete's expected revision is stale and returns conflict;
- no partial audit record is committed when the hard delete fails.

### Delete-all/create/update race

Delete-all issues one owner-scoped `DELETE ... RETURNING` inside its audit
transaction. Its `entryCount` is exactly the returned row count:

- a create committed and visible before the delete statement is included;
- a create that becomes visible after the statement may remain as the later
  database action and is not counted;
- an update committed first can still be deleted and contributes one row;
- an update that encounters a row already deleted returns not found and cannot
  recreate it.

This defines a short database-order boundary without a user-wide distributed lock.
After any mutation the UI reloads page one and trend; it does not infer all-time
state from the previous 7/30-day list.

### Network uncertainty

- A pending create retains its request ID and body only in React memory. An unknown
  result uses read-only creation-status confirmation; it is not automatically
  submitted again.
- Update/delete are not automatically retried because Phase 5D has no immutable
  operation receipt. The client fetches authoritative state before enabling another
  explicit action.
- Delete-all is also not automatically retried. After an unknown result the client
  reloads; a new confirmation is a new operation and may include entries created
  after the first request.
- A late response carries a component/request generation identity and cannot
  overwrite a newer edit, route, session, or user state.
- Logout/session invalidation aborts active Mood/Profile requests and clears cached
  entries, profile email, drafts, client request IDs, and dialog state.

This is intentionally smaller than ADR-016's legal-decision ledger. A general Mood
event-sourcing or permanent idempotency table is not justified.

### Required timing outcomes

| Scenario                                                                             | Required result                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two concurrent creates use the same user/key                                         | One row. One request inserts; the other resolves the same current row after the unique conflict.                                                             |
| A successful row is edited, then the original create POST is repeated                | No new write; the new payload is ignored; return the edited current row as `existing`, not as an immutable receipt.                                          |
| A create result is unknown, another tab deletes the row, then the first tab confirms | Read-only confirmation returns `absent`; it neither recreates the row nor claims the original POST failed.                                                   |
| Delete-all commits before a late create becomes visible                              | The late create may survive and is absent from `entryCount`; refresh displays it as a later database action.                                                 |
| Create commits before delete-all's delete statement                                  | Delete-all removes it and includes it in `entryCount`; later read-only confirmation returns `absent`.                                                        |
| An old create POST is manually repeated after hard deletion                          | With no durable tombstone it can create again; the supported Web flow prevents this by requiring a new explicit action/new key after an absent confirmation. |
| Delete-all result is unknown                                                         | Reload only; do not retry automatically. A new confirmation is required before another delete-all.                                                           |
| Range pagination crosses Asia/Shanghai midnight                                      | Cursor retains the original calendar bounds and creation ceiling; a fresh first page starts the new window.                                                  |
| An entry is edited/deleted between page requests                                     | Later responses may show the change; no cross-page snapshot is promised; refresh page one and trend.                                                         |
| A row has an eligible earlier `createdAt` but commits after page one                 | It may affect a later response or be missed by the current keyset position; explicit refresh is the reconciliation boundary.                                 |

## 8. Profile scope

The Profile page at `/app/profile` displays:

- account email — read-only, because changing an authentication identifier requires
  verification and recovery design;
- account creation date — read-only account context;
- adult eligibility completed date — read-only, without the provider or evidence;
- links to Privacy/Consent and logout — existing product flows, not duplicated
  mutation logic.

No editable Profile field is proposed. This is the minimum useful Profile and
requires no database column. A future email/password change flow must require
appropriate re-authentication and verification and should be scoped separately.

## 9. Relationship to Auth, Consent, AI, and safety

| Condition                                                     | Mood                   | Profile                | Chat                                          |
| ------------------------------------------------------------- | ---------------------- | ---------------------- | --------------------------------------------- |
| Authenticated, current AI-admission Consent set               | Available              | Available              | Existing capability/quota/safety rules apply. |
| Authenticated, required AI-admission Consent absent/withdrawn | Available              | Available              | Blocked by existing Consent admission.        |
| Authenticated, AI disabled                                    | Available              | Available              | Disabled as today.                            |
| Authenticated, quota exhausted                                | Available              | Available              | Existing risk-first/quota behavior applies.   |
| Session invalid                                               | Cleared and redirected | Cleared and redirected | Existing abort/cleanup behavior applies.      |

The current Consent set controls third-party AI admission; Phase 5D does not claim
that its legal meaning governs every non-AI account feature. Mood notes are not sent
to the LLM, RiskDetectionService, OutputSafetyCheck, or HumanReviewQueue. The
feature must say that records are not continuously monitored and are not a diagnosis
or emergency-response channel. A future proposal to analyze notes would need a
distinct purpose, Consent/privacy review, safety routing, and ADR assessment.

Persistent Conversation, Incognito, Consent lifecycle, Quota, AI streaming, and
Phase 4 safety contracts remain unchanged.

## 10. Privacy and security boundaries

- Score, emotion, note, entry objects, Profile email, and drafts do not enter URLs,
  browser persistent storage, telemetry, or ordinary logs.
- Page/API data remains in memory and is cleared at session invalidation/logout.
- Notes render as plain text; no Markdown, HTML, or `dangerouslySetInnerHTML`.
- API success logging is optional and must never accept a Mood DTO. Prefer no
  per-check-in operational event over creating another sensitive analytics stream.
- Mood deletion appends an existing restricted Audit Log action with content-free
  allowlisted metadata. Delete-all may include only the server deletion count; no
  action records a score, emotion, note, or trend.
- Account deletion and backup erasure are not implemented or promised.
- Rate limiting/abuse controls remain a production-readiness concern and do not
  change the data model proposed here.

## 11. Migration plan

Implementation will generate the actual next forward-only migration (currently
expected to be `0006`) from the Drizzle schema. It must not modify `0000`–`0005`.

Validation must cover:

1. empty protected `_test` database applies every migration from zero;
2. a database at the current `0005` schema with synthetic users, Consent,
   conversations, risk events, and audits upgrades without changing those rows;
3. `mood_entries` starts empty—there is no fabricated backfill;
4. checks, user cascade, unique creation key, and owner/range index exist;
5. a deliberately invalid synthetic insert is rejected atomically;
6. no migration is marked applied after failure.

There is no Profile migration because no Profile field or table is proposed.

## 12. Implementation split

### Phase 5D-1 — Mood/Profile backend

- accept ADR-017 after design approval;
- shared types and Zod contracts;
- Drizzle `mood_entries` schema and generated forward-only migration;
- `MoodModule`, date-range policy, repository, service, controller, and content-free
  deletion audit action;
- owner-scoped minimal `ProfileModule` read service/controller;
- API, concurrency, timezone, migration, logging/privacy, and regression tests;
- API/privacy documentation and CI.

Rollback boundary: no Web route depends on these endpoints until this PR is merged.

### Phase 5D-2 — Mood/Profile Web experience

- `/app/mood` and `/app/profile` routes and application navigation;
- check-in/edit/delete/history/trend states;
- responsive and accessible interaction;
- stale/unknown-result handling and session cleanup;
- Vitest/RTL plus a small Chromium P0 flow;
- final Phase 5D status documentation and CI.

Rollback boundary: the backend remains useful and independently tested if the Web
delivery is held back. Neither batch begins Phase 5E or Phase 6.

## 13. Acceptance plan

### API/domain

- score bounds, emotion allowlist, whitespace/null normalization, and the same
  500-code-point limit for Chinese, Latin text, simple emoji, combining characters,
  and multi-code-point emoji sequences in Web/API/PostgreSQL;
- multiple same-day entries, concurrent same-key create, and cross-user isolation;
- same-key/different-payload first-write-wins, including return of a subsequently
  edited current row without applying the retry payload;
- read-only unknown-create confirmation after another-tab single/delete-all removal,
  proving that confirmation does not recreate content;
- seven/thirty-day Asia/Shanghai boundaries with a controlled Clock, including
  exact local midnight and cross-UTC-day cases;
- fixed range/creation ceiling, ordering, pagination, and malformed/mismatched
  cursors without claiming a cross-page snapshot;
- same-response entries/trend consistency under a concurrent edit, plus documented
  refresh behavior for cross-page edit/delete/late-commit races;
- daily average/count and missing-date behavior;
- owner isolation for read/update/delete;
- update/update and update/delete concurrency with barriers, not sleeps;
- delete-all interleavings with create/update, exact server count, zero-row no-audit,
  and content-free atomic audit rollback;
- exact Audit action/resource/idempotency/metadata allowlists and unchanged Audit
  read authorization;
- AI disabled, quota exhausted, and Consent withdrawal do not block Mood/Profile;
- Mood calls no classifier/provider and creates no RiskEvent;
- errors/logs contain no score, emotion, note, email, request body, or SQL detail.

### Migration

- empty database application;
- non-empty `0005` upgrade preservation;
- constraint/index inspection;
- invalid migration data fails safely;
- user lifecycle leaves no Mood orphan.

### Web

- create, read-only unknown-result confirmation, explicit new-key recreation,
  edit conflict, per-entry/delete-all confirmation, empty/loading/error states, and
  seven/thirty-day selection;
- unknown create followed by other-tab delete never re-POSTs the old key;
- multi-tab stale update/delete refresh;
- delete-all/late-create refresh and unknown delete-all no-auto-retry behavior;
- missing dates and multiple-entry daily summary presentation;
- keyboard score selection, visible labels/errors, dialog focus trap/restore, and
  non-color-only trend text;
- mobile layout, long-note wrapping, touch targets, and reduced-motion compatibility;
- plain-text XSS regression;
- no Mood/Profile/draft data in browser persistent storage or URL;
- logout/session expiry clears User A state before User B signs in;
- AI disabled/Consent withdrawn still permits Mood/Profile while Chat stays blocked.

### Chromium P0

One synthetic flow is sufficient: login → create two same-day check-ins → view 7/30
trend → edit one → delete one → refresh → verify remaining history → delete all →
logout. It uses the existing protected `_test` database/seed and no real user or
model data. Component tests retain the detailed failure/concurrency UI cases.

## 14. Implementation approval boundary

The following product scope was approved for contract finalization on 2026-09-11:

1. 1–5 score, the optional bounded emotion vocabulary, and a 500-code-point note;
2. multiple entries per day with no backdating in the first implementation;
3. per-entry/delete-all hard deletion plus content-free Audit actions;
4. a read-only Profile made solely from existing identity data, with no new profile
   attributes or account-credential mutation.

ADR-017 remains Proposed and the PR remains Draft until this finalized engineering
contract is reviewed. There is no discovered implementation-blocking ambiguity in
the contract. Accepting the ADR would authorize implementation, not any production
policy or AI enablement.

## 15. Production-only unresolved matters

These do not block the bounded engineering implementation while the product remains
disabled for production AI:

- reviewed privacy wording for Mood retention and the fact that notes are not
  continuously monitored;
- production account-deletion, Mood retention, Audit retention, and backup-erasure
  policies;
- database encryption/key management and backup/restore verification;
- abuse prevention/rate limiting;
- all previously recorded AI/safety/provider/reviewer/crisis-resource readiness
  blockers.

The following project status remains unchanged:

- Production Safety Lock: Enforced
- Production AI Chat: Disabled
- `productionSafe=false`
- Real Model Safety Evaluation: Not Evaluated
