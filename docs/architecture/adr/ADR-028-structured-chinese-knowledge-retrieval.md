# ADR-028: Structured Chinese Knowledge Retrieval

- Status: Accepted
- Date: 2026-09-18
- Supersedes: ADR-027 only for search indexing, ranking, parent expansion and evaluation scope
- Authorization: User requested actual knowledge optimization using all three supplied retrieval/chunking diagrams.

## Decision

Keep the existing structured content contract and immutable version/source evidence.
Normalize NFKC/case only in the derived search view. Headings retain level-2/level-3
ancestry; list items remain separate and callouts remain atomic. Unsupported PDF,
table or arbitrary Markdown input is not silently flattened or newly accepted.

Build ephemeral search children, at most 400 Unicode code points with up to 60
code points of overlap, preferring Chinese/Latin sentence punctuation. Fall back
to code-point boundaries for long unpunctuated text. This is a character budget,
not a claim of exact 400-token chunks. Children retain the original block ordinal
and heading path; they never replace stored content or become citation identities.

Add Node/ICU Chinese word segmentation alongside existing bounded bi-/trigrams.
A word-channel hit requires at least two distinct query words in one child plus
its heading path, and 40% word coverage across the article. Existing n-gram
admission remains available. Rank by lexical evidence and suppress second
candidates below 80% of the top score. These are versioned heuristic thresholds,
not truth or entailment checks. Query stopwords affect search only, not the original
question, negation, Provider prompt or safety classifiers.

Deliver whole original parents: prefer the entire short article when it fits,
otherwise use complete sections with preamble and all callouts as in ADR-027.
Skip oversized groups intact. The 800–1,200 estimated budget, 50-candidate bound,
two-reference maximum, eligibility, currentness recheck and safety/lifecycle
boundaries are unchanged. Do not introduce embeddings, GraphRAG, rerank services,
schema, new publication states, frontend protocol changes or extra runtime LLM calls.

## Evidence and limits

Evaluate fixed authored questions against the user's actual local reading drafts
without importing/publishing them. Record input hashes and Node/ICU versions.
Compare the previous policy, 400/512 sizes, overlap on/off and section-only parent
expansion. A bounded real-provider sample may use only these synthetic/public
materials; no private chat or diary is used. It is a development sample, not a
clinical assessment or completion of Real Model Safety Evaluation.

See the [evaluation report](../../reviews/knowledge-retrieval-optimization.md).
The corpus remains unverified. Fiction remains non-factual material; a similar
title or valid citation never proves a claim. The model must still abstain when
evidence is insufficient. No-hit ordinary support and HIGH/CRITICAL routing remain
unchanged. Long cross-section dependencies still need explicit content authoring;
this design cannot infer them all. Formal source/content review is not replaced.
