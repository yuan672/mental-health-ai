# ADR-019: LLM Knowledge Retrieval and Citation Boundaries

- Status: Accepted
- Date: 2026-09-11
- Refines: ADR-013, ADR-014, ADR-015, ADR-018
- Related: ADR-003, ADR-006, ADR-007, ADR-008, ADR-016
- Supersedes: None

## Context

HANDOFF section 17 retains `LLM + Knowledge` as a product direction. Accepted
ADR-018 now provides immutable Knowledge article versions, ordered sources,
environment-aware visibility, a controlled publication lifecycle, and an
independent authenticated reader. It deliberately required the AI integration to
receive a separate design and authorization.

The current corpus is deliberately small. `LLMProvider.embed()` remains an
unsupported capability, and the system has no vector database or external search
service. The established AI path already has required Consent, Risk Detection,
trusted Crisis/Safety routes, quota semantics, guarded Provider dispatch, output
safety, cancellation, late-result rejection, persistent/Incognito boundaries, and
a four-event SSE protocol.

Generated citations create additional integrity and privacy risks. A model must
not invent source URLs or silently point an old answer to a new article version.
Persistent citations need to survive history reload without copying the user's
query or Knowledge body, while Incognito citations must remain ephemeral. The
current strict Web parser also makes an unnegotiated completion-payload extension
unsafe for rolling deployments.

## Decision

### Bounded local retrieval

Add an application-owned `KnowledgeRetrievalService`. For a quota-eligible LOW or
MEDIUM normal generation, after Risk Detection and the real Pre-Generation Safety
route, it obtains a short repeatable-read snapshot of currently eligible exact
article versions, bodies, and ordered sources from PostgreSQL. It ranks them in
process using a code-versioned deterministic lexical policy over only the current
user message.

The initial policy scans at most 50 current candidates, selects at most two, and
places only bounded whole blocks into a Knowledge allowance within the existing
context budget. It uses Unicode normalization, Chinese n-grams, bounded Latin word
tokens, weighted title/summary/heading/body matches, stable tie-breaking, and a
minimum relevance threshold. Exact weights and initial token limits are tested
engineering defaults, not clinical constants.

No embedding provider, vector database, external search, cache, long-term query
index, personalization, Mood/Profile linkage, or reading profile is introduced.
No-hit, candidate-limit, and ordinary local retrieval failure use the unchanged
non-grounded chat path. Abort, Consent withdrawal, session invalidation, or deadline
is never converted to a miss.

Pre-route HIGH, CRITICAL, classifier-unavailable, quota safety fallback,
CrisisFlow, and trusted degraded responses do not retrieve Knowledge. A trusted
post-Output-Safety replacement can occur after retrieval and grounded generation,
but the rejected candidate and all prepared references are discarded; the
replacement itself carries no Knowledge reference.

### Eligibility and exact-version snapshot

Staging and Production may retrieve only `published + curated + source_verified`
versions admitted by the controlled publication policy with non-null review
identity/time and frozen sources. The database cannot prove the human review's
quality; that remains organizational evidence. Development/Test
may additionally retrieve `published + synthetic_fixture + unverified` only through
the explicit guarded fixture mode. Draft, withdrawn, curated-unverified, synthetic
outside Development/Test, and reserved `professional_reviewed` records are never
eligible. Candidate review files are not eligible content.

The selection pins the immutable article-version identity and its exact source set.
A final short currentness recheck is the precise cut-off: a change visible then
discards the bundle and rebuilds the ordinary no-Knowledge context without swapping
in a newer version. A successful recheck freezes the snapshot as this turn's
in-flight contract. Persistent mode then atomically consumes quota/appends the user
message/starts the turn before the Consent-guarded Provider fetch. Because content
publication and network dispatch do not share a lock, a later withdrawal may commit
before the fetch starts; it changes future retrieval but cannot retarget the frozen
citation or be described as recalling third-party bytes.

Abort, Consent revocation, or deadline at the final recheck terminates rather than
becoming a no-hit. Persistent quota is not yet consumed; Incognito uses its existing
idempotent refund path if admission already consumed it.

Retrieval revalidates hydrated body blocks and sources through the complete
application Zod contracts. It skips a whole block that cannot fit the remaining
Knowledge allowance and treats a result with no included body block as a no-hit.

Historical references do not link to the current-version Knowledge route. The
initial citation UI shows the exact title/version and frozen sources without
exposing withdrawn article body. Owner-scoped history may keep the exact credential-
free HTTPS source links with a visible no-longer-current warning; this is provenance,
not a withdrawn-body read or an endorsement of currentness.
An exact historical-body reader, including supersession versus urgent-withdrawal
policy, requires a separate decision.

### Knowledge is data, not instruction

Use a separate code-versioned grounded-chat prompt. It wraps selected title,
summary, and whole blocks in a strict bounded data envelope with turn-local `K1`
and `K2` identifiers. The system prompt directs the model to ignore instructions
inside the Knowledge data and forbids model-authored source metadata. Source URLs,
reviewer IDs, and database IDs are not sent to the generation Provider.

Prompt separation is defense in depth, not a safety system or proof against prompt
injection. Knowledge never enters the Risk Detection context. Every generated
answer still passes the existing real Output Safety gate and all Consent,
cancellation, deadline, quota, and late-write guards.

### Full-buffered grounded response

For a hit, the application consumes the real upstream stream but buffers the whole
bounded output. The Provider returns strict JSON containing plain-text `answer` and
a non-empty unique subset of the supplied reference IDs. The model cannot return a
URL, article identity, version, source, reviewer, or free-text reasoning as citation
metadata.

The application validates the envelope and reference IDs, rejects source-like URL
or inline-citation markup in the answer, and runs full-response Output Safety before
anything is emitted. Malformed or unknown references fail closed and never become
public metadata. Trusted fallback or replacement text always has no Knowledge
references.

This contract can prove which exact reference data was offered and which allowlisted
identifier the Provider selected. It cannot prove semantic entailment of every
sentence. User language says that the response “参考了以下知识版本”; it does not claim
claim-level evidence, clinical validation, or accuracy. Real-model grounding and
safety evaluation remains a production prerequisite.

The guarantee that the model cannot invent a source applies to structured and
clickable metadata. The plain-text answer remains untrusted natural language; a
bounded URL/citation-syntax check cannot prove that every possible prose attribution
or implied factual claim was detected.

### Server-owned answer-level references

The API constructs every public reference field from the exact selected database
snapshot. It exposes bounded article key, title, version, actual content origin and
review status/date, current availability, and ordered source identity. Source output
must be HTTPS and contain no URL credentials. No internal UUID, reviewer identity,
query, term, score, snippet, Provider metadata, or arbitrary model field is public.

`K1`/`K2` exist only inside the Provider request/response envelope. The server
validates the returned subset, normalizes it to prompt-slot order, and persists the
public response order. Turn-local K identifiers are not exposed or treated as
durable IDs.

An invalid source URL makes a current candidate ineligible. If abnormal database
corruption is encountered when reading an old persisted reference, the API returns
a bounded no-link provenance tombstone rather than expose the URL or make the
owner's entire Conversation history unreadable.

Current source evidence belongs to an entire article version. Phase 5E therefore
does not claim sentence- or claim-level mapping to one source. Such granularity
would need a separately reviewed claim/block-to-source authoring model and output
contract.

### Persistent and Incognito lifecycle

Add a narrow ordered relation from an assistant message to an exact immutable
Knowledge article version. The relation has no user ID or content-derived fields.
It is committed atomically with the assistant message and completed AI turn and is
unique per message/version. It cascades with message deletion and restricts article-
version deletion until a future dependency-closed content lifecycle handles it.
It follows Conversation/Message retention and is not an independent permanent
interest profile.

While its matching AI Turn remains, a completed Persistent `clientRequestId` replay
reads this stored relation and does not rerun retrieval or resolve the article key
against a newer version. A duplicate Incognito `clientRequestId` retains the
existing fail-closed behavior and never reruns retrieval or generation, even while
its context still exists.

Do not put references in `ai_turns`. Do not persist retrieval queries, normalized
tokens, ranks, scores, snippets, prompt copies, article bodies, or source copies.

Incognito references remain only in the active execution, SSE, and React memory.
They are not written to the process-memory context, Conversation, Message, AI Turn,
Risk Event, Audit, browser storage, or a new table. Only approved assistant text
enters later LLM Conversation Context.

### Negotiated protocol refinement

Keep `turn.started`, `message.segment`, `turn.completed`, and `turn.failed` as the
only public SSE event names. In the negotiated v2 representation,
`message.segment` and `turn.completed` both carry a required `deliveryMode` of
`immediate` or `commit_with_references`, and completion adds a bounded
`knowledgeReferences` array. Negotiated message history similarly adds a required
array to each message. Persistent and Incognito variants retain their strict
discriminated IDs.

No-hit semantic segments and trusted deterministic replacement text use
`immediate` with empty references and retain their existing visible/failure
semantics. A Knowledge hit emits exactly one full-buffered approved
`commit_with_references` segment. The Web holds that body in bounded React memory
without rendering or announcing it. Only a strict matching completion with a valid
non-empty reference array promotes body and references together in one reducer
transition. This is an atomic client-state transition, not a claim that the two SSE
events or network delivery are atomic.

Because a Persistent commit or Incognito context append can precede the first
segment's arrival, recovery is request-level rather than conditional on observing a
grounded segment. After stream admission or an unknown POST outcome, missing,
truncated, invalid, mismatched, or late completion, a grounded completion without
its required pending segment, and any other absence of a strict matching terminal
leave the result unresolved; a typed stream-parser error is not proof that the turn
failed. Persistent mode performs a strict v2 owner-scoped history read that commits
a stored assistant body and references to visible state together. POST-based
metadata recovery also uses the original `clientRequestId`, but it requires both
positive admission evidence for that execution and the confirmed original
`conversationId`. An existing-Conversation request supplies only the latter until
`turn.started` or the post-claim v2 response acknowledgement arrives; a new-chat
request obtains the ID from valid `turn.started`. Normal deletion/purge then makes
the old Conversation lookup fail instead of falling back to a new Conversation/
turn. An acknowledged stream without the original ID is not enough. The existing
completed-request replay remains metadata-only only while its turn exists; it
neither regenerates nor adds a body-replay endpoint. Until history/bound metadata
recovery resolves the outcome, the Web does not offer retry-as-new.

This bound reuse depends on the current lifecycle invariant that AI Turns are not
independently purged while their Conversation remains; normal cleanup deletes both
through the Conversation cascade. A future independent turn-retention policy must
remove this non-creating claim or obtain a separately approved contract. Historical
admission evidence is not a permanent tombstone.

After a grounded Persistent commit or Incognito context append wins its protected
barrier, a later serialization or socket failure cannot be represented as a
definitive `turn.failed` implying that side effect did not occur. The delivery is
unresolved and follows Persistent reconciliation or Incognito retirement. This
does not change the existing immediate trusted-text-plus-failure contract when the
trusted response itself was not persisted.

Only passive network uncertainty, when the user still explicitly wants to proceed,
may use an unbound same-ID creation-capable continuation. If no turn was previously
claimed, or ordinary retention removed the former Conversation/turn, it may
execute/create a turn and has no across-purge at-most-one guarantee; it is not
metadata recovery. If the original matching turn still exists, it returns existing
metadata without a second Provider call or quota charge. Explicit cancel, deadline,
workspace/account termination, Session invalidation, and Consent withdrawal never
invoke this unbound POST continuation.

The implementation must correlate the supplied original `conversationId` with any
existing/replayed AI Turn, including a concurrent claim conflict. A mismatch fails
with a typed conflict and cannot return a replacement turn, change the recovery
target, create work, call a Provider, or consume quota.

Incognito has no recovery reader. Any possibly accepted request without a strict
matching terminal retires the context identity even if no segment arrived. It
discards a pending grounded delivery and relies on existing cancel/end/TTL cleanup
without persistence or generation replay. Immediate trusted text already shown may
retain its existing failure qualification, but the retired context is not reused.

Use an explicit `X-MH-Knowledge-References: 1` request capability. Clients without
it receive v1 shapes and Knowledge augmentation is disabled for their stream.
Clients with it receive strict v2 shapes; the response acknowledges the selected
representation with the same header and `Vary`. Unsupported non-empty capability
values fail with a typed 400 response. A v1 history request for a page containing a
referenced message fails closed with HTTP 406 `CLIENT_CAPABILITY_REQUIRED`; it may
not return the answer while silently omitting its provenance. The error carries a
bounded update-required message, and the Web does not commit an unparseable history
body. The allowed Web origin can read the acknowledgement because CORS exposes
this response header.

Rollout order is the backend schema/guard, then the citation-aware Web and 406
handler, then augmentation enablement. With no reference rows and augmentation
disabled, old v1 API/Web behavior remains sufficient. Once reference rows may
exist, disabling augmentation stops new grounded answers but does not permit
rolling back the strict v2 history reader, reference presentation, or v1 history
guard. Old/stale clients receive 406 and must update for affected pages. Removing
that deployed floor requires a separate verified change after normal Message
lifecycle cleanup has removed every reference dependency and no reference-capable
in-flight turn can still commit one. The safe order is to disable new augmentation
admission, drain or abort those turns under existing late-result guards, verify
zero stored references and zero possible writers, and only then review a deployment
floor reduction. Rollback never deletes references, clears Conversations, or
rewrites/retargets historical evidence.

For a persistent grounded answer, assistant text, exact-version references, and
completed turn state commit before the single approved answer segment and
completion are emitted. That transaction enables authoritative recovery but does
not prove that the browser received either event. Incognito appends only approved
assistant text to its context; references travel through SSE to React memory.
Existing final Consent and cancellation checks precede every SSE write.

### Consent, third-party, quota, and logging

Local PostgreSQL retrieval is not a new third-party dispatch. The risk classifier,
generation, and output classifier remain bound to the exact accepted Consent and
start network requests through `ConsentExecutionCoordinator`. A future hosted
embedding or retrieval provider would be a new dispatch kind requiring separate
Consent, privacy, Provider, timeout, and cancellation approval; this decision does
not authorize it.

Knowledge does not change the single-turn quota. Local retrieval is not separately
charged. No-hit normal generation and grounded generation each consume at most one
turn. Existing cancellation, disconnect, timeout, before/after-approved-content
refund, and `finishReason=length` rules remain authoritative.

Allowlisted operational metadata is limited to fixed retrieval outcome, policy and
prompt versions, duration, bounded counts, and fixed failure category. Logs may not
accept a query, normalized term, score, body/snippet, article key/title, source
record/URL, citation payload, prompt, raw Provider response, or an arbitrary error.
They must not combine a user/turn identity with an article identity to form a second
interest profile.

Development/Test citation UI visibly labels synthetic references
“测试内容 · 未核验”. Curated `source_verified` references use only the narrow
“来源已核对” meaning from ADR-018 and do not claim expert, clinical, legal, or
professional review. Staging and Production cannot receive synthetic references.

### Independent reader and production state

The authenticated independent Knowledge reader remains unchanged and available
without AI Consent, AI quota, or AI availability. This decision adds no search,
taxonomy, favorites, reading history, formal content publication, or management
surface.

Acceptance of this ADR authorizes the architecture and the bounded Knowledge AI-A
backend implementation batch. Knowledge AI-B Web implementation still requires a
separate review and authorization. This decision does not authorize content
publication, Production AI enablement, or a real-model claim. Production Safety
Lock remains enforced, Production AI Chat remains disabled, `productionSafe=false`,
and Real Model Safety Evaluation remains Not Evaluated.

## Consequences

### Benefits

- The first retriever matches current corpus scale without new infrastructure or a
  new third party.
- Every public reference is tied to immutable server evidence rather than model-
  generated metadata.
- Full buffering prevents invalid citation structure and unchecked grounded text
  from leaking through token streaming.
- Persistent provenance survives refresh while Incognito remains ephemeral.
- Version replacement cannot silently rewrite an old citation into a new article.
- Explicit capability negotiation gives API and Web a safe rollout and an explicit
  data-dependent rollback floor.

### Costs and limitations

- Lexical matching misses paraphrases and requires a bounded corpus.
- Full buffering increases time to first visible content for Knowledge hits.
- The Web must retain a bounded hidden grounded buffer and reconcile Persistent
  history when completion delivery is uncertain; Incognito cannot recover that
  ephemeral delivery.
- Article-level sources cannot justify per-sentence citation claims.
- The message-version relation is a limited derived-interest signal and must remain
  protected by Conversation access and deletion rules.
- Withdrawal after the final currentness recheck may race ahead of Provider
  dispatch; it cannot recall later third-party bytes, and exact snapshot provenance
  is retained instead.
- Frozen source metadata does not archive the external page or guarantee continued
  URL availability.
- Engineering validation cannot establish real-model citation accuracy, safety, or
  clinical benefit.

## Alternatives considered

### Vector search or external embeddings now

Rejected for the initial corpus. It would add indexing, invalidation, Provider,
Consent, privacy, cost, deletion, and evaluation obligations before evidence shows
lexical retrieval is insufficient.

### PostgreSQL full-text search

Not selected initially because Simplified Chinese tokenization and ranking require
additional configuration/extensions while the bounded in-process corpus is small.
It is a reasonable later replacement behind the same application port.

### Append source URLs to model-authored answer text

Rejected. It mixes trusted provenance with untrusted output, is difficult to parse,
does not persist structurally, and lets a model invent or alter links.

### Stream grounded text before citation validation

Rejected because an invalid reference or unsafe later segment could arrive after
the browser already displayed unsupported content.

### Claim-level citations

Deferred. The current content schema does not map claims or blocks to individual
sources. Pretending that it does would be less trustworthy than an explicit
article-version reference panel.

### Link citations to the current article route

Rejected because `/app/knowledge/:articleKey` resolves the current version and
would silently show version 2 for a version-1 response.

### Persist only transient SSE references

Rejected for persistent chat because a refresh would lose provenance. Incognito
uses this ephemeral model deliberately because it must not create ordinary history.

## Accepted scope and implementation conditions

The following product choices were accepted on 2026-09-11:

1. answer-level exact article-version/source-set references rather than claim-level
   mapping;
2. full-buffer delivery for hits;
3. the final-currentness-recheck cut-off and immutable in-flight snapshot rule;
4. retaining exact frozen external source links for an unavailable historical
   article version with a visible currentness warning; and
5. the message-lifecycle relation with no historical-body reader in the first
   implementation.

Implementation still requires a forward-only migration, strict shared/API/Web
schemas, synthetic deterministic tests, Provider-contract tests, orchestration and
privacy regression, and separate backend and Web review. Production enablement
additionally requires approved curated content and reuse rights, verified Consent
and Provider data-processing terms, real-model retrieval/citation/safety evaluation,
and all existing Phase 4 production readiness work.
