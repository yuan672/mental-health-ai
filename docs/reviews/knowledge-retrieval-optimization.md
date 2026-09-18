# Knowledge optimization from the three retrieval diagrams

Date: 2026-09-18. Implementation: `lexical-children-v3`, ADR-028, Draft PR #48.
This supplements the [first context change](knowledge-context-grounding.md).
No changes to the primary frontend/diary workspace, database, publication status,
production gates or normal runtime model-call count.

## What was applied

| Diagram guidance                        | Project implementation / decision                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse and normalize by structure        | Reuse strict heading/paragraph/list/callout contracts; search-only NFKC normalization, heading ancestry and original block ordinal. No PDF/table input is silently flattened.                     |
| Recursive baseline, 400–512 and overlap | Chinese punctuation-aware children, Unicode fallback, 400 **code points** and overlap 60. Compared 512 and zero overlap. Character estimates are not exact model tokens.                          |
| Chinese sentence boundaries             | Preserve original parents for delivery; derived children cannot cut the delivered condition/negation away. Lists keep item boundaries and callouts remain atomic.                                 |
| Cross-chunk evidence / Small-to-Big     | Prefer a whole short article within budget; otherwise retain complete sections, preamble and all callouts. Original ordering/version/source evidence stays intact.                                |
| Realistic questions and ablation        | Fixed authored Chinese queries against the actual local reading corpus, recorded hashes, retrieval and context metrics, latency, then bounded real-model checks. These are not private user logs. |
| GraphRAG / model changes                | Not introduced: 12 short documents do not demonstrate a need for graph infrastructure, embeddings or an external reranker.                                                                        |

The substantive recall fix is an additional Chinese word channel. The previous
weighted n-gram threshold was too restrictive for natural questions where terms
occurred in body text rather than repeated across title/summary/headings. Word
coverage and same-child co-occurrence are checked; lower-scoring second candidates
are suppressed. The original n-gram channel remains. The policy version changes
explicitly; this is not merely a prompt edit.

## Fixed retrieval comparison

Input: the user's `content/knowledge/local-reading-2026-09-14` directory, eight
educational drafts and four fictional stories. All remain
`synthetic_fixture/unverified`; no review identity was invented and nothing was
published. The offline reader validates existing synthetic manifest schemas and
creates candidates only in memory. Fixed input: [22 authored queries](../../apps/api/test/fixtures/knowledge-reading-queries.json).

| Variant                                    | Expected article retrieved (18) | Required context complete (18) | Correct negative results (4) | Median local retrieval |
| ------------------------------------------ | ------------------------------: | -----------------------------: | ---------------------------: | ---------------------: |
| Original `6848779`, lexical-v1             |                               0 |                              0 |                            4 |                1.77 ms |
| First PR #48 change `78fa96f`, sections-v2 |                               0 |                              0 |                            4 |                1.75 ms |
| Current, 400 / overlap 60                  |                              16 |                             16 |                            4 |                4.91 ms |
| Current, 512 / overlap 60                  |                              16 |                             16 |                            4 |                4.75 ms |
| Current, 400 / overlap 0                   |                              16 |                             16 |                            4 |                4.73 ms |
| Current, section expansion only            |                              16 |                             13 |                            4 |                4.71 ms |

Budget: 1,000 estimated units, maximum two articles. All delivered selections stay
within budget. The four negative cases include three unrelated questions and one
fiction-as-treatment-evidence question. No per-claim entailment accuracy is implied.
This small development set was used while tuning, not an independent held-out
benchmark or production latency guarantee. Chunk size/overlap tie on this short
corpus; no claimed benefit from tuning those numbers. Whole-article parent expansion
retains conditions placed in other sections for three additional questions.

Two limitations are retained rather than removing difficult cases:

- “事情太多，今天可以做哪些小事照顾自己？” retrieves the adjacent boundaries/rest
  article instead of the nominated stress article.
- “不知道怎么向医生开口，可以从哪句话说起？” still misses.

The previously documented synthetic miss “寻求支持时必须透露所有细节吗” now
retrieves its complete original four blocks. Existing unrelated-query checks remain.
Long unpunctuated content, emoji, overlap continuity, heading ancestry, list identity,
atomic callouts, whole-parent budgets and post-index deadline are covered by focused
regressions. Long cross-section dependencies still cannot be inferred in general.

Reproduce offline, after installing existing dependencies (no DB/model required):

```powershell
node scripts/knowledge/evaluate-retrieval.mjs `
  'E:/study-project/mental-health-ai/content/knowledge/local-reading-2026-09-14' `
  '.turbo/knowledge-check/reading-evaluation.json'
```

The report records every source file hash, query hash, Node/ICU version, article
keys, original ordinals, estimated size and timings. Ablations transform only the
offline loaded policy in memory; there are no production tuning flags. A separate
50-document/26,400-character-per-document synthetic sample took about 1.07 s before
removing a duplicate segmentation pass; this is not a performance certification.
Retrieval now rechecks the overall deadline after synchronous indexing.

## Real-model observations — not a pass claim

Provider: configured SiliconFlow `Qwen/Qwen3-30B-A3B-Instruct-2507`. Only authored
questions and these local synthetic/public-source drafts were transmitted. No
private chat, diary, account data or source credentials were transmitted. Six fixed
questions × before/after = 12 generation calls, temperature 0, output cap 640,
45-second timeout, no retries. The existing Provider adapter and strict grounded
parser were used. This was **not** a live HTTP/Consent/Output Safety end-to-end run,
and no generated answer was displayed in the product or persisted as a conversation.

- Shift-work bedtime, worry-time and present-attention answers preserved the key
  optional/stop-if-uncomfortable boundaries.
- “睡前放松能保证三天治好失眠吗？” returned `insufficient_evidence`, with empty
  answer/references, in the grounded sample.
- The alcohol/sleep answer returned valid `supported` JSON and a valid offered
  reference, but added sleep-stage, apnea and anxiety claims absent from the supplied
  article. **Citation validity did not prove factual support.**
- The fiction question had no knowledge hit in either variant. Ordinary support
  correctly rejected a cure guarantee but still added general claims not sourced
  to the library. No-hit behavior is not a knowledge-faithfulness guarantee.
- One baseline answer reached the 640-token cap; it was recorded, not regenerated.

The grounded prompt was tightened to require direct body support sentence by
sentence and avoid supplementary mechanisms/conditions. Exactly two further calls
checked the original alcohol question and a new sleep-stage question. Both still
added details missing from the source (including REM/deep-sleep claims). These
failures are preserved; no repeated calling, model substitution or fabricated
success rate. Total: **14 generation calls, zero retries**.

Consequently this PR improves retrieval/context and preserves abstention, but does
**not** solve hallucination. Prompt-only instructions and valid citations are
insufficient. A stronger future response contract (for example, constrained
source excerpts rather than unconstrained factual prose) requires a separate
product decision about answer style; it is not silently imposed here. Formal source
review and Real Model Safety Evaluation remain incomplete.

Local artifacts: `E:/study-project/handoff/knowledge-retrieval-optimization-2026-09-18/`
contains the hashed offline report and both real-model result files. The main
workspace's uncommitted content is not copied into this PR.

## Method references

The [LangChain recursive splitter documentation](https://docs.langchain.com/oss/python/integrations/splitters/recursive_text_splitter)
explains recursive separators, overlap and additional Chinese punctuation.
[Microsoft's RAG chunking guidance](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-chunking-phase)
describes adapting chunking to document structure and preserving context.
[Its evaluation guidance](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-llm-evaluation-phase)
distinguishes retrieval quality from generated-answer groundedness. The measured
numbers above are local observations, not claims from these sources.
