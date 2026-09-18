# ADR-027: Knowledge Context and Insufficient Evidence

- Status: Accepted
- Date: 2026-09-18
- Supersedes: ADR-019 only for block selection and the internal grounded Provider envelope
- Authorization: User approved the scoped implementation plan in this task.

## Decision

Keep lexical retrieval, the 50-candidate bound, at most two exact article versions,
the existing estimated context budget, eligibility, currentness recheck, and all
Consent/safety/lifecycle guards. No new storage, frontend protocol, or model service.

Rank existing whole blocks, then expand a hit to its level-2 section (including
level-3 subsections). A document without level-2 headings is one section. Include
the article preamble and, conservatively, every callout as shared article context;
there is no existing metadata that reliably identifies article-wide caveats.
Deduplicate ordinals, preserve original order, and require non-heading body content.
Budget each complete group before selection; skip oversized groups instead of
dropping conditions. Do not split, rewrite, or persist derived content. This cannot
infer every dependency between different sections; advice and conditions should be
authored together in future reviewed content versions. Character-based estimates
remain estimates, not an exact Provider tokenizer.

The versioned internal Provider response becomes a strict union:

- `status=supported`: nonempty `answer` and one or two unique offered reference IDs.
- `status=insufficient_evidence`: empty `answer` and empty `usedReferenceIds`.

Missing/unknown status, contradictory fields, extra fields, and invalid references
fail closed. Do not accept the old untagged envelope for newly generated turns.
Existing completed messages/history are unaffected; they do not parse this envelope.

For insufficient evidence, only a fixed server-owned explanation enters the existing
output safety check. No Provider answer, source claim, or citation is delivered or
stored. Persistent mode uses ordinary no-reference completion; Incognito appends
only the approved explanation to its ephemeral context. Both deliver existing v2
`immediate` events with empty references. Keep existing quota, cancellation, expiry,
unknown-result and recovery semantics. Do not retry generation or invoke a new
fact-checking model. Supported answers retain full buffering, atomic reference
completion and `commit_with_references` delivery.

No-hit, unavailable retrieval, and currentness failure continue ordinary chat as in
ADR-019. General support must not claim knowledge-library support without references.
HIGH/CRITICAL and trusted safety routing are unchanged. This is an abstention signal,
not semantic entailment verification or a guarantee against hallucination.

## Scope and verification

Use synthetic material only for local comparison; do not convert reading drafts or
fictional stories into approved factual evidence. Keep formal publication and all
production gates unchanged. Validate section completeness, budget/version boundaries,
strict envelopes and both no-reference delivery modes with focused checks. Compare
twelve fixed synthetic queries offline; do not claim real-model or clinical results.

ADR numbers 023–026 are already allocated to ongoing diary/profile work in the
user's primary workspace; this decision deliberately uses 027 without changing it.
