# Mood and Profile API

The authenticated Mood API supports the approved eight-cat Web check-in and legacy
scored records. `/profile` still returns minimal identity facts; display settings
are documented separately in `diary-and-settings.md`. No clinical interpretation,
third-party AI analysis, or Risk Detection is performed.

## Routes and access

| Method   | Path                                             | Purpose                                      | CSRF |
| -------- | ------------------------------------------------ | -------------------------------------------- | ---- |
| `POST`   | `/mood-entries`                                  | Create or resolve a live idempotency key     | Yes  |
| `GET`    | `/mood-entries?days=7\|30&limit=&cursor=`        | Read a bounded history page and daily trend  | No   |
| `GET`    | `/mood-entries/creation-status/:clientRequestId` | Read the current result for a creation key   | No   |
| `GET`    | `/mood-entries/:id`                              | Read one owned entry                         | No   |
| `PATCH`  | `/mood-entries/:id`                              | Replace editable fields at a known revision  | Yes  |
| `DELETE` | `/mood-entries/:id`                              | Hard-delete one entry at a known revision    | Yes  |
| `DELETE` | `/mood-entries`                                  | Hard-delete all entries owned by the account | Yes  |
| `GET`    | `/profile`                                       | Read existing minimal account facts          | No   |

Every route requires the existing server-side Session. Mutations also require the
existing trusted Origin and double-submit CSRF token. Responses and errors use
`Cache-Control: private, no-store`. Owner IDs are taken only from the authenticated
principal; missing and non-owned entries share `404 NOT_FOUND`.

Mood/Profile access does not depend on AI Chat being enabled, daily AI quota, or
the current third-party AI admission Consent. No Mood operation calls an LLM,
classifier, Risk Detection, Crisis Flow, or Risk Event service.

## Mood value contract

Under ADR-024, new check-ins send `catMood`: `happy`（开心）, `sad`（委屈）,
`angry`（生气）, `surprised`（惊讶）, `shy`（害羞）, `sleepy`（困倦）,
`hopeful`（期待）, or `relaxed`（放松）. They send no inferred numerical score.
Create and update require at least a valid cat or a legacy `moodScore` (integer
1–5). Responses return nullable `moodScore` and `catMood`; existing records retain
their original score. `emotion` is optional and, when present, is one of:

`joyful`, `calm`, `hopeful`, `neutral`, `tired`, `stressed`, `sad`, `angry`, or
`overwhelmed`.

Each `dailyTrend` item also includes `latestEntry: { catMood, moodScore, emotion }`
from the last record of that Shanghai calendar day, ordered by creation time then
ID. This is computed over the full requested range regardless of the history page
limit, within the same repeatable-read transaction. The Web shows this last cat,
not a score average. The compatibility field `averageMoodScore` averages only
scored records and is null when no scored record exists that day.

`note` is optional, trimmed by the API, and limited to 500 Unicode code points.
The API counts with Unicode code-point iteration and PostgreSQL enforces the same
limit with `varchar(500)` and `char_length`. The client does not provide
`createdAt`; server receipt time is stored as UTC and cannot be edited.

## Create and unknown-result confirmation

Create accepts a UUID `clientRequestId`. The database unique key on
`(user_id, client_request_id)` makes concurrent same-user submissions converge on
one live row. While that row exists, a repeated key ignores the new payload and
returns the row's current state with `disposition: "existing"`. An intervening edit
may therefore appear in the response; it is not an immutable receipt of the first
payload.

The read-only creation-status response is a strict union:

```json
{ "success": true, "data": { "status": "present", "entry": {} } }
```

or:

```json
{ "success": true, "data": { "status": "absent" } }
```

`absent` is only a point-in-time observation. It can mean no visible row, a row
that was hard-deleted, or an original create that has not committed yet. It does
not prove failure, rollback, cancellation, or that the old request will never
commit. The service stores no permanent operation ledger, content copy, hash, or
tombstone. Idempotency is deliberately bounded to the row's lifetime.

## History and trend

`days` is exactly 7 or 30. Asia/Shanghai defines the local calendar window while
all timestamps remain UTC. Results are ordered by `(created_at, id)` descending.
The opaque cursor fixes the selected range and a first-page creation-time ceiling,
so crossing midnight does not change that cursor's date window. The server derives
the exact seven- or thirty-day Asia/Shanghai window again from that ceiling and
rejects enlarged, shifted, future-ceiling, or internally inconsistent cursors with
`400 VALIDATION_ERROR` before running the Mood history query.

Each response reads its entry page and the complete window trend from one short
repeatable-read database view. Separate pages are not a historical snapshot:
edits, deletes, or a late commit with an earlier creation time may change or be
missed by later pages. After a mutation, clients refresh page one and the trend.

`dailyTrend` contains only dates that have at least one entry, with `localDate`,
`entryCount`, and the arithmetic mean `averageMoodScore` rounded to one decimal.
Missing dates remain gaps and are never interpreted as zero or a clinical signal.

## Revision, delete, and Audit behavior

Update and single delete require `expectedRevision`. A changed update increments
the revision; an exact no-change update does not. A current owned row at a different
revision returns `409 MOOD_STATE_CHANGED`. A missing or non-owned row returns 404.

Single and delete-all operations hard-delete Mood content. The deletion and its
content-free Audit action share one transaction, so an Audit failure rolls the
deletion back. Delete-all uses the rows returned by its database `DELETE`, includes
records outside the visible 30-day window, and returns the actual `entryCount`.
A zero-row delete-all writes no Audit row.

Audit metadata never includes score, emotion, note, or trend. The only new actions
are `mood_entry_deleted` and `mood_history_deleted`; the latter records only a
positive `entryCount`.

## Minimal Profile

`GET /profile` joins existing identity data and returns only:

```json
{
  "success": true,
  "data": {
    "email": "user@example.test",
    "accountCreatedAt": "2026-09-01T00:00:00.000Z",
    "adultEligibility": {
      "verified": true,
      "verifiedAt": "2026-09-01T00:01:00.000Z"
    }
  }
}
```

It does not expose an internal user/session ID, password hash, verification method,
provider evidence, Consent evidence, or safety data. Phase 5D-1 adds no Profile
table and no editable personal fields.

## Privacy and delivery boundary

Mood rows have no automatic expiry and do not inherit Conversation's 90-day
retention. They remain for the account lifetime unless explicitly hard-deleted;
the user foreign key cascades on technical account deletion. Production account
deletion, backup erasure, and retention policy remain separate unresolved policy
work.

Application code does not log Mood DTOs or Profile email, and precise Pino
redaction paths provide defense in depth. Phase 5D-2 Web pages, browser-memory
cleanup for those pages, and product privacy copy remain outside this backend PR.

Production Safety Lock remains enforced, Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.
