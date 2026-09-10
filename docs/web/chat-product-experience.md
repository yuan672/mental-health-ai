# Phase 5B Chat Product Experience

Phase 5B provides the first user-facing Web product shell for ordinary persisted
chat. It uses React Router, the existing authenticated Conversation APIs, and the
existing `POST /ai/chat/stream` safety pipeline. It does not add a direct-provider,
debug, or safety-bypass endpoint.

## Routes and session boundary

- `/` is the public landing page.
- `/login` and `/register` are public authentication pages.
- `/app` redirects into the protected chat shell.
- `/app/chat` is a local draft; it does not create an empty database Conversation.
- `/app/chat/:conversationId` loads an owner-scoped ordinary Conversation.

The root Session Provider distinguishes guest sessions from retryable bootstrap
errors. Logout or a 401 session invalidation aborts active generation and unmounts
the authenticated caches/workspace so chat bodies, drafts, and request identifiers
do not survive into another user's session.

## Streaming and reconciliation

The browser uses `fetch()` plus `ReadableStream` to consume the existing SSE event
contract. `turn.started` can replace the draft URL without remounting or cancelling
the active stream. Approved text remains visible when a later `turn.failed` reports
that persistence failed; the UI distinguishes displayed text from committed
history.

The browser does not automatically retry generation. A definite failed/cancelled
turn uses a new client request ID when the user explicitly retries. A network result
whose outcome is unknown may reuse the same ID only to exercise the server's
existing idempotent-turn response; the UI otherwise asks the user to reconcile by
refreshing history. Message bodies and session material are never written to browser
persistent storage.

## Registration and production boundary

Registration first reads `GET /auth/registration-requirements`. If the server says
registration is unavailable, the form cannot submit. Enabled Development/Test
fixtures use only server-returned consent versions and supplied test evidence; the
Web never creates age evidence or hard-codes consent versions.

Production Safety Lock remains enforced. Production AI Chat remains disabled,
`productionSafe=false`, and real-model safety evaluation remains not evaluated.
The synthetic Playwright provider validates engineering integration only and is not
a real-model quality or safety evaluation.

## Browser P0 validation

`pnpm test:e2e` runs Chromium against an isolated PostgreSQL database whose name
must end in `_test`. Setup migrates that database from zero, seeds one synthetic
adult account with required consent, and starts a local OpenAI-compatible HTTP/SSE
fixture. No real provider key, external model call, or real psychological content is
used.
