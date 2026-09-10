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
sanitized, paginated history. It is read-only in this batch. ADR-011's existing
withdrawal lifecycle remains unchanged, including the prohibition on same-version
reacceptance after withdrawal. Product/legal decisions for withdrawal UX,
reopening, account deletion, backups, and final Risk Event/Audit retention remain
unresolved readiness work.

Production Safety Lock remains enforced, Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.
