# ADR-017: Mood Tracking and Minimal Profile Data Boundaries

- Status: Proposed
- Date: 2026-09-11
- Related: ADR-003, ADR-004, ADR-007, ADR-008, ADR-009, ADR-011,
  ADR-015, ADR-016

## Context

Phase 5D introduces basic user-entered mood check-ins, seven-day and thirty-day
history, and the smallest useful account profile. Mood score, emotion, and note
are sensitive wellbeing data. They must not become diagnoses, hidden AI input,
ordinary operational-log content, or another long-term user-profile system.

The current identity model deliberately stores no real name, birthday, gender,
address, employer, school, diagnosis, or analytics profile. Authentication uses a
server-side session, and AI admission is separately controlled by current Consent,
quota, and safety gates. Mood and Profile must preserve those boundaries.

## Proposed decision

### Mood check-in semantics

A check-in records a required integer `moodScore` from 1 through 5, one optional
primary `emotion`, an optional note of at most 500 characters, and server-owned
timestamps. Labels describe the user's present self-report from “很低落” through
“很好”; they do not represent a clinical score or diagnosis.

The first bounded emotion vocabulary is:

- `joyful`（愉快）
- `calm`（平静）
- `hopeful`（有希望）
- `neutral`（一般）
- `tired`（疲惫）
- `stressed`（有压力）
- `sad`（难过）
- `angry`（生气）
- `overwhelmed`（不堪重负）

The UI presents Simplified Chinese labels and always permits no emotion selection.
No score/emotion correlation is enforced. The note supplies optional nuance but is
not parsed into labels.

Users may create multiple check-ins on one local calendar day because mood can
change during the day. Phase 5D does not support backdating: `createdAt` is the
server receipt time and cannot be edited. An update replaces score, emotion, and
note while preserving `createdAt`; an explicit delete hard-deletes the row. Because
the product only exposes seven/thirty-day history while records can outlive that
window, it also exposes an explicit delete-all action for every Mood row owned by
the account, including rows outside the visible window.

### History and trend boundary

The public history supports only the current local day plus the preceding 6 or 29
local calendar days. Asia/Shanghai defines those calendar boundaries. Timestamps
are stored as UTC `timestamptz` values and returned as ISO 8601 strings.

Entries are paged newest first by `(created_at, id)`. A cursor freezes the selected
range boundaries and an `asOf` ceiling from the first page, so a page request that
crosses local midnight or races a new check-in does not silently change its data
snapshot. The response also contains one derived daily summary per day that has at
least one record: local date, entry count, and arithmetic mean score rounded to one
decimal. Missing dates remain gaps and are never interpreted as a zero or an
inferred mood. The UI renders entry history and labels the summary as being based
only on recorded check-ins.

No summary row is persisted. No prediction, diagnosis, recommendation engine,
sentiment model, risk classification, embedding, or AI analysis is part of this
feature.

### Persistence model

Add one `mood_entries` table:

- `id uuid primary key`
- `user_id uuid not null references users(id) on delete cascade`
- `client_request_id uuid not null`
- `mood_score integer not null`
- `emotion varchar(32) null`
- `note varchar(500) null`
- `state_revision integer not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Use a unique index on `(user_id, client_request_id)` for creation idempotency and
an index on `(user_id, created_at, id)` for owner-scoped range/history reads.
Database checks enforce score 1–5, positive revision, note length, and timestamp
ordering. The application and shared Zod schemas enforce the bounded emotion
codes; the database stores the stable code as text rather than a PostgreSQL enum.

Mood entries have no `expires_at` and do not inherit Conversation's ninety-day
policy. They remain while the account exists unless the user explicitly deletes
them. User deletion cascades the rows so the table cannot create orphans. This is
an engineering relationship, not a final production account-deletion, backup, or
legal-retention policy.

Deletion is a hard delete, not a content-bearing tombstone. In the same transaction,
append one existing Audit Log action containing only the bounded action/resource
identity and content-free safe metadata. A delete-all action may record the actual
server deletion count, but no score, emotion, note, or derived trend. Audit retention
remains independent and undecided for production.

### Mutation concurrency and retry

Creation accepts a client-generated UUID `clientRequestId`. The first insert wins.
Repeating that identifier for the same authenticated user returns the existing
entry and does not create another row, even if a buggy retry carries different
fields. No note/content fingerprint or duplicate payload is retained. Different
users may use the same identifier. The guarantee lasts while the mood row exists;
Phase 5D does not add a permanent operation ledger after user deletion.

Updates and deletes carry `expectedRevision`. The repository combines entry ID,
authenticated user ID, and revision in the write predicate. One competing update
wins; a stale update or delete returns `MOOD_STATE_CHANGED`. Missing and non-owned
resources share `404 NOT_FOUND`.

Phase 5D does not add an update/delete operation ledger. A network result that is
unknown is resolved by re-reading authoritative server state; the client does not
automatically issue a replacement mutation or claim which request changed the
row. A hard-deleted row is reported as no longer present, without claiming that a
specific uncertain request performed the deletion. Delete-all is also never
automatically retried: a retry could delete a new check-in created after the first
request, so the user must reload and make a new explicit decision.

### Minimal Profile

Do not add a profile table or new user attributes. `GET /profile` reads only data
already required by identity:

- normalized account email;
- account creation time; and
- adult-eligibility verification time.

It does not expose the password hash, verification method/provider, evidence,
session ID, Consent evidence, user-risk information, or internal user ID. Phase 5D
adds no editable Profile field. Email/password changes require separate re-
authentication and verification design and are not disguised as ordinary profile
editing.

Do not add display name, real name, avatar, birthday, gender, address, employer,
school, diagnosis, biography, preferences, or profile analytics without a concrete
approved use case.

### Authorization, Consent, and AI independence

Mood and Profile require a valid authenticated session and owner-scoped queries.
State-changing Mood endpoints retain Origin and double-submit CSRF protection.
Responses use `Cache-Control: private, no-store`.

Mood and Profile remain available when AI Chat is disabled, quota is exhausted, or
the current required Consent set used by third-party AI admission is absent or
withdrawn. This engineering separation does not decide whether future service
terms should gate non-AI account features. Mood and Profile do not send text to an
LLM or invoke Risk Detection. The UI must not imply that a mood note is monitored
for an emergency. Any future analysis or safety processing of Mood content requires
an explicit privacy/product decision and a new integration review.

### Client and logging privacy

Score, emotion, note, draft, and history remain in React memory only and are never
written to `localStorage`, `sessionStorage`, IndexedDB, or URLs. Rendering remains
plain text. Logout/session invalidation clears Mood/Profile server-data caches and
pending mutation state through the existing protected-application boundary.

Application logs never receive a Mood DTO, score, emotion, note, derived daily
summary, or request body. The existing request-body redaction is defense in depth.
No create/update success log is required. The bounded deletion Audit Log contains
no wellbeing content.

## Consequences

- Users can record changing moods without a false one-record-per-day model.
- Seven/thirty-day views have deterministic local-date semantics without storing a
  second local-date projection.
- Creation retries are idempotent without hashing or duplicating sensitive notes.
- Optimistic revisions prevent lost updates without a general operation ledger.
- Mood remains a self-recording tool rather than a hidden AI, diagnosis, or safety
  surveillance input.
- Profile delivers useful account information without expanding personal-data
  collection.
- Backdated entries, all-time browsing/export, email/password change, account
  deletion, and production retention/backup promises remain outside this decision;
  delete-all remains available even though all-time browsing is not.

## Alternatives considered

### One check-in per local day

Rejected because it overwrites meaningful within-day changes and forces an update
when the user intended a second observation. Multiple entries plus a daily derived
summary stays simple and preserves self-reported history.

### A 0–10 or clinical questionnaire score

Rejected for V1. A five-point self-report is easier to understand and less likely
to be mistaken for a validated clinical instrument. No clinical interpretation is
attached to it.

### Free-text or multi-select emotions

Rejected for the first batch. Free text duplicates the note and complicates trend
display; multi-select expands filtering and accessibility work without a confirmed
need. One optional primary emotion is a deliberately small product contract.

### Backdated check-ins

Deferred. Correct backdating needs a separate occurrence timestamp, timezone UX,
and rules for future/old dates. Server-time check-ins are the smallest truthful
first implementation.

### A mutable profile table

Rejected because no approved Phase 5D product field currently justifies additional
personal-data collection. Existing identity facts are enough for the first Profile
screen.

### Reusing AI Consent or Risk Detection for mood notes

Rejected. Mood storage is an independent authenticated feature. Sending its text to
a third party or classifying it would add a materially different processing purpose
and user expectation.

## Adoption condition

This ADR remains Proposed until the Phase 5D product semantics—particularly the
five-point scale, bounded emotion list, multiple entries per day, no backdating,
and read-only minimal Profile—are approved. Approval would authorize engineering
implementation, not production privacy wording, account-deletion/backup policy,
clinical validation, AI enablement, or real-model evaluation.
