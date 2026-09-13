# Account Deletion API

This endpoint implements the bounded ADR-022 local learning/demo contract. It is
disabled by default and can be enabled only when `APP_ENV` is `development` or
`test`. It is not a Production account-deletion, backup-erasure, Provider-recall,
or legal-retention claim.

## Command

`POST /account/deletion`

The request requires a current ordinary User Session, an allowed Web Origin, the
existing CSRF cookie/header pair, current-password reauthentication, and this
strict body:

```json
{
  "operationId": "c2d6540b-04a3-45cf-a41a-c33f6fd9ca67",
  "currentPassword": "<current password>",
  "acknowledgeIrreversible": true
}
```

The command accepts no target User ID or email. A confirmed commit returns `204 No
Content`, clears the authentication and CSRF cookies, and returns no deletion
receipt or account data.

The operation ID is a process-bound coordination key, not a durable public receipt.
At most one unresolved attempt is retained per User, with a fixed global limit. An
exact retry can join or reconcile only while the original authenticated,
process-local attempt remains available. A process restart or a deleted User cannot
authenticate an unauthenticated status lookup because no such endpoint exists.

## Transaction and lifecycle

After password verification, the API serializes with the existing per-User Consent
lock. It installs a terminal runtime marker, aborts pending/bound AI executions,
and clears idle and active Incognito contexts. New Consent binding, Incognito
creation, Provider dispatch, output emission, message append, and completion fail
closed while an unresolved marker remains.

The database transaction locks the authenticated User and exact Session, checks one
database observation time, rejects a pre-existing deletion Audit key, inserts the
required content-free Audit, and deletes exactly one User. The existing foreign-key
graph removes ordinary identity, Session, Consent, Conversation, Message, AI Turn,
Mood, and Quota rows. Risk Events retain their independent deadline with User/chat
references set null; their Queue items remain while the Risk Event exists. Existing
Audit, Staff, and Knowledge records keep their separate lifecycles.

If commit acknowledgement is lost after mutation begins, a bounded confirmation
transaction waits on the same User serialization point before checking the exact
Audit. Until commit or rollback is attributable to the live attempt, the public
result is `ACCOUNT_DELETION_RESULT_UNKNOWN` and runtime processing remains blocked.
The server does not claim rollback merely because a normal read cannot see a row.

## Errors and privacy

- `ACCOUNT_DELETION_DISABLED` — not enabled in an eligible local/Test environment.
- `INVALID_CREDENTIALS` — current-password verification failed.
- `ACCOUNT_DELETION_OPERATION_CONFLICT` — the operation ID or required Audit key is
  not attributable to this attempt.
- `ACCOUNT_DELETION_IN_PROGRESS` — a different unresolved attempt already owns the
  User lifecycle boundary.
- `ACCOUNT_DELETION_RESULT_UNKNOWN` — the mutation began but commit/rollback cannot
  yet be attributed safely.
- Existing `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `RATE_LIMITED`, and
  bounded database/internal errors apply before the destructive boundary.

Request bodies are redacted by the application logger. Password, email, Cookie,
Session/CSRF token, operation ID, and psychological content are not written to
ordinary operational logs by this feature. The required Audit contains only the
bounded self-service action metadata and does not expand the Admin Audit-read
allowlist.
