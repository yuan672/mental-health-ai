# Proposed Consent Product Decision Note

- Status: Proposed — decision pending
- Applies to: Phase 5C product behavior built on ADR-011
- Does not amend or supersede an Accepted ADR

## Existing accepted constraints

ADR-011 is the current source of truth for the consent lifecycle. The server's
`ConsentPolicyService` defines the two required types, `terms_of_service` and
`privacy_policy`; their current versions come from validated server
configuration. A client cannot declare a type or version to be current.

Each `(user, consent type, consent version)` has one explainable lifecycle.
Acceptance creates the row, withdrawal changes that row to `withdrawn` while
preserving `acceptedAt`, and the same withdrawn version cannot be accepted again.
A new version creates a new row. A user may still withdraw a known historical
version that exists in their own history.

## Current recovery-of-use implication

AI use requires every current required policy to be accepted. If a user withdraws
a currently required version, AI use is blocked. Under the accepted one-lifecycle
rule, the user cannot restore AI use by re-accepting that same version; restoration
requires a later policy version to be configured and accepted. Authentication and
permitted history/deletion capabilities are separate from that AI consent gate.

This is an implementation consequence, not a newly approved product or legal
policy. User-facing withdrawal copy must not promise same-version restoration
unless a later decision changes the lifecycle.

The current backend applies a conservative runtime boundary to every successful
withdrawal of a known owned Consent record: it cancels this process's active AI
executions for the user and clears that user's Incognito contexts. Future request
eligibility is still determined only by the current required versions. Because
this batch exposes no withdrawal UI, whether a historical-only withdrawal should
continue to interrupt otherwise eligible active use remains an explicit product
decision rather than an implied toggle behavior.

## Policy options requiring a future decision

The project may retain the current irreversible-per-version rule, allow repeated
accept/withdraw cycles, or distinguish the lifecycle and product consequences of
terms from privacy consent. The latter two options would change an Accepted ADR
and may require different persistence and audit semantics. Either change requires
an explicit product/legal decision and a new ADR that supersedes the affected part
of ADR-011 before implementation.

This note does not approve consent wording, legal effect, account-deletion policy,
third-party processing terms, or any lifecycle alternative.
