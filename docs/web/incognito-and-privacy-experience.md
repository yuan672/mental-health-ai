# Incognito and Privacy Experience

Phase 5C adds a user-facing Incognito chat mode and an authenticated privacy view.
This batch does not define new consent policy, account deletion/export, or legal
retention promises.

Incognito content and its opaque context identifier live in React and API-process
memory only. They are not written to browser persistent storage or ordinary
Conversation, Message, and AI Turn tables. Explicit end, logout, consent withdrawal,
session expiry, inactivity TTL, or process restart clears or loses the runtime
context. Refresh is not recoverable. The UI does not use `sendBeacon`, because it
cannot preserve the existing custom-CSRF-header policy; explicit end, logout, and
TTL are the cleanup mechanisms.

User wording must not promise that “nothing is stored.” Incognito ordinary chat is
excluded from long-term history, while minimal Risk Event and Audit records may be
retained under the accepted safety policy when required. User text may still be
processed by configured third-party AI generation and safety-classification
providers when AI chat is enabled and required consent is active.

The privacy view shows server-reported current required consent status and a
sanitized, paginated decision history. The current feature delivery adds explicit
acceptance, withdrawal, same-version re-acceptance, new-version confirmation, and
historical/legacy withdrawal controls on top of ADR-016's backend contract.
`GET /consents` separates historical displayable evidence from the current
`acceptableDocument`, and exposes authoritative `consentStates` revisions for
current and historical withdrawals. `POST /consents` uses the strict action union,
an in-memory operation ID, and the server revision; unknown results are reconciled
only by exact replay, while stale policy/state conflicts require a fresh explicit
choice. Development/Test document links resolve to version-controlled synthetic
pages served only by the Vite development server; their path, document key,
version, and revision match the server Registry. Every Vite build excludes these
pages. They are not a completed production document-reading experience or policy
link, and Staging/Production cannot select or advertise them. No legacy mutation
bypass is exposed. The UI remains pending review and merge, so overall Phase 5C
is not yet complete.

Development/Test use visibly synthetic Consent documents. They are not production
policy content and cannot make Staging/Production registration or third-party AI
admission eligible. Product/legal decisions for formal document content, the
meaning and sufficiency of the current Consent types, retention, account deletion,
backups, and final Risk Event/Audit retention remain unresolved readiness work.

Production Safety Lock remains enforced, Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.

## Consent lifecycle UI implementation

The bounded Phase 5C UI delivery turns the authenticated Privacy page into the
client for ADR-016 without changing its backend semantics. The page treats
`currentRequiredConsents` as the admission-policy view, `consentStates` as the
authoritative revision source for current and historical projections,
`acceptableDocument` as the only source for a new acceptance, and paginated
decision receipts as immutable history only.

The page state is `loading | ready | load_failed` plus one in-memory mutation at
a time: `confirming | submitting | result_unknown | stale | failed`. A new
affirmative action creates one operation ID and an immutable request snapshot.
Double clicks are disabled; an unknown-result retry reuses that snapshot and ID.
A 409 refreshes server state and requires a new explicit action. Route changes,
logout, and newer operations invalidate older responses. No Consent interaction
state is written to `localStorage`, `sessionStorage`, or IndexedDB.

Development/Test document links point to version-controlled, visibly synthetic
read-only pages whose key and revision match the server registry. They are test
fixtures, not approved production policy. Staging/Production acceptance remains
unavailable until the server exposes a `production_reviewed` document.

Verification covers current acceptance, withdrawal, same-version re-acceptance,
new-version and legacy confirmation states, historical withdrawal, unavailable
documents, exact unknown-result retry, stale multi-tab responses, late-response
rejection, accessible confirmation focus, and active Persistent/Incognito cleanup.
Existing chat, Incognito, session-isolation, privacy, and Chromium P0 regressions
remain required. This delivery does not add account deletion/export, policy CMS,
new Consent types, cross-instance cancellation, or Phase 5D/5E/6 features.
