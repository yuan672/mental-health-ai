# Phase 5D-2 Mood and Profile Web Experience

This delivery adds the authenticated `/app/mood` and `/app/profile` routes on top
of the Phase 5D-1 API. It does not add Profile fields, Mood analysis, AI calls,
Risk Detection, production enablement, or any Phase 5E/6 capability.

## Mood interaction contract

The Mood page records a score from 1 through 5, one optional bounded emotion, and
an optional note. Notes are trimmed and measured with Unicode code-point iteration
before submission; the browser does not use a UTF-16 `maxLength` boundary that can
split emoji. Entries use server timestamps and may occur multiple times per day.

The seven-day and thirty-day views send server cursors back as opaque strings and
display the returned `period`, `timeZone`, `averageMoodScore`, and `entryCount`.
Dates missing from `dailyTrend` are shown as "未记录", not zero, and no trend is
given a clinical interpretation. Entry notes are rendered as plain text.

Create uses a new `clientRequestId` for every explicit submission. A transport or
server result whose commit status is unknown is checked only through the read-only
creation-status endpoint; the UI never automatically replays the old POST.
`present` and `absent` are point-in-time observations rather than immutable
receipts. Starting another explicit create uses a new ID and does not claim to
cancel a possibly late old request.

Update and single delete submit the latest server `stateRevision`. A conflict or
unknown mutation result triggers an authoritative read rather than an automatic
mutation retry. If that read fails, stale data may remain visible but cannot be
used for another mutation. An unknown delete-all result refreshes history and is
never automatically replayed, because a replay could delete entries created after
the original request.

Delete-all explains that it includes every owned Mood row, including rows outside
the visible window. Its result uses the server's `entryCount`; the browser does
not infer a count from loaded pages. Copy does not promise deletion of separate
Audit records or backups.

## Profile and privacy boundary

The Profile page displays only the API-provided email, account creation time, and
adult-eligibility verification time. It has no editable field and links to the
existing Privacy experience.

Mood/Profile require a valid Session but do not depend on AI enablement, AI quota,
or third-party AI admission Consent. They do not invoke a provider, classifier,
Risk Detection, or Risk Event path. Mood content, Profile email, form drafts,
pending request IDs, and response caches remain in component memory; route exit,
logout, and session invalidation abort active requests and unmount those values.
They are not written to URLs, browser persistent storage, application logs, or
telemetry.

## Verification boundary

Vitest and Testing Library cover strict response parsing, Unicode validation,
opaque cursors, unknown-result handling, stale revisions, server delete counts,
plain-text rendering, AI-disabled access, and session-invalidated cleanup.
Chromium P0 uses the protected synthetic `_test` database and exercises two
same-day records, both ranges, trend values, edit, single delete, refresh,
delete-all, Profile, responsive widths, and logout.

Review screenshots are stored in
`docs/reviews/phase-5d-mood-profile-web/` for desktop Mood, mobile Mood, and mobile
Profile states. They contain synthetic test data only.

Production Safety Lock remains enforced. Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.
