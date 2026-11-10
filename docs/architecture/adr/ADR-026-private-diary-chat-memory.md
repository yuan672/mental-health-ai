# ADR-026: Opt-in private diary context for persistent chat

- Status: Accepted
- Date: 2026-09-15
- Authorization: the user reviewed the personal-memory proposal, specified none / selected notebooks / all notebooks, then explicitly requested implementation.
- Partially supersedes ADR-023's absolute exclusion of diary text from AI, and ADR-019's exclusion of personal linkage only for this separate opt-in path. Public Knowledge governance and all safety/Consent gates remain unchanged.

## Decision

Store a separate revisioned account policy: `none` (default), `selected`, or `all`.
Selected grants reference owned notebook IDs with deletion cascades. All includes
future notebooks; selected does not. Changing policy is authenticated, CSRF
protected, explicit-save and conflict checked; old clients cannot grant access by
updating unrelated personal settings. The form discloses that selected text is
sent to the configured AI provider and that already-sent data cannot be recalled.

Only persistent normal LOW/MEDIUM generation may retrieve diary context, after
risk assessment and pre-generation routing. Incognito, high/crisis/unavailable
routes and exhausted-quota fallbacks never retrieve it. A per-request skip flag
can narrow access, never grant it, and is preserved when recovering an uncertain
request. Required AI Consent, quotas, cancellation and output checks still apply.

Use the current account ID from authentication. Locally select at most 50 saved
entries within today and six preceding calendar days in Asia/Shanghai, rank by
current-message lexical overlap and recency, and include at most five bounded
text excerpts within the existing context-token budget. Drafts, photo bytes,
photo IDs, notebook names, embeddings, external indexes and persistent generated
summaries are excluded. Date, title, saved mood/weather and text may be sent.
The diary envelope is explicitly untrusted user data, not instruction, medical
evidence or proof of the user's present state. Ask rather than infer current facts.

Each request reads fresh policy/content and rechecks the exact saved-content hash,
permission and seven-day window just before provider dispatch. A stale bundle
fails before dispatch rather than sending stale text. This final database check
is the in-flight snapshot cutoff; changes committed afterwards affect subsequent
requests, not bytes already prepared/sent. No claim of third-party recall is made.
Ordinary retrieval failure continues without diary context; abort/deadline errors
are not swallowed. No stored raw diary is passed into the risk classifier.

Record only turn-bound notebook/day/revision references after provider dispatch
is confirmed, never copies of diary text, title, query or prompt. Records cascade
with AI-turn/conversation/account removal. A separate owner-only GET provides
the latest turn's reference dates/titles and links. Changed/deleted pages are
tombstones; no old body is reconstructed. UI says data was provided, not that
every fact was used. Missing metadata does not prove that no bytes were sent.
Existing assistant text may mention past diaries; closing access does not erase
chat history. The user can start a new chat or delete old conversations.

## Validation

Review additive Drizzle migration and apply first to a new empty `_test` database.
Test none/selected/all, future notebooks, foreign IDs, revisions and CSRF, date
boundaries, saved/draft and image exclusion, prompt separation/budget, stale and
deleted context, persistent provider dispatch and Incognito exclusion, metadata
ownership and cascades. Use only synthetic accounts/messages; no real user diary
is sent to a test provider. UI acceptance stays exclusively manual.
