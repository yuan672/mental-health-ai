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
sanitized, paginated decision history. It remains read-only in this batch. The
backend now implements ADR-016's document-bound accept/withdraw contract,
same-version re-acceptance, immutable decision receipts, exact operation replay,
dependency-scoped runtime cancellation, and commit-acknowledgement-loss
reconciliation. `GET /consents` separates historical displayable evidence from
the current `acceptableDocument`, and exposes authoritative `consentStates`
revisions for current and historical withdrawals. These are backend contracts for
the next delivery; the page does not yet provide user-facing withdrawal,
re-acceptance, stale-tab, or new-version controls. Synthetic `example.invalid`
locations are test fixtures, not a completed document-reading experience or
production policy link. No legacy mutation bypass is exposed.

Development/Test use visibly synthetic Consent documents. They are not production
policy content and cannot make Staging/Production registration or third-party AI
admission eligible. Product/legal decisions for formal document content, the
meaning and sufficiency of the current Consent types, retention, account deletion,
backups, and final Risk Event/Audit retention remain unresolved readiness work.

Production Safety Lock remains enforced, Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.
