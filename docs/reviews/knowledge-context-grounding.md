# Knowledge context and abstention delivery

Scope: whole-section retrieval and an explicit insufficient-evidence exit. The
implementation follows [ADR-027](../architecture/adr/ADR-027-knowledge-context-and-insufficient-evidence.md).
No frontend, database migration, content publication, or production enablement.

## Fixed offline comparison

Baseline: `6848779674a9421576839bac8210d612fa4d0330`, `lexical-v1`.
Candidate: `lexical-sections-v2`. Both use the same three synthetic articles,
twelve fixed queries, weights, thresholds and estimated budget of 1,000.
The [fixture](../../apps/api/test/fixtures/knowledge-context-cases.json) contains no
user chat/diary content, and is not published into a database.

Numbers below are original block ordinals from the expected article. A complete
section retains its explanatory body, conditions and callout. These are targeted
context-selection examples, not measured answer accuracy or broad recall claims.

| Query                        | Before  | After         |
| ---------------------------- | ------- | ------------- |
| 工作压力怎么安排休息         | 1, 2    | 1, 2, 3, 4, 5 |
| 工作压力休息一定有效吗       | 1, 2    | 1, 2, 3, 4, 5 |
| 工作压力时我能做些什么       | 1, 2    | 1, 2, 3, 4, 5 |
| 休息安排有不适用情形吗       | 1, 2, 3 | 1, 2, 3, 4, 5 |
| 如何用纸笔整理担忧           | 1, 2    | 1, 2, 3, 4, 5 |
| 写下担忧后下一步是什么       | 1, 2    | 1, 2, 3, 4, 5 |
| 写下担忧能保证问题解决吗     | 1, 2, 5 | 1, 2, 3, 4, 5 |
| 不方便写下担忧怎么办         | 1, 2    | 1, 2, 3, 4, 5 |
| 如何向信任的人表达需要       | 1, 2    | 1, 2, 3, 4    |
| 寻求支持时必须透露所有细节吗 | No hit  | No hit        |
| 推荐股票涨幅                 | No hit  | No hit        |
| 欧洲火车时刻表               | No hit  | No hit        |

All nine previous hits now carry their complete required context. The one known
lexical miss remains a miss despite relevant available material; it is explicitly
marked in the fixture, not removed or fixed by loosening thresholds. Both unrelated
queries still miss. Estimated hit sizes increase from 121–157 to 200–241, all
within budget. No additional model call, vector index, or corpus scan is introduced.

## Verification and limits

Focused checks cover whole sections and callouts, original ordering/version/source
identity, oversized groups, heading-only rejection, strict response status and
the existing v2 completion union. PostgreSQL integration cases cover Persistent
and Incognito abstention, no references, no regeneration, history/replay, and
contradictory-response rejection alongside the existing grounding lifecycle cases.

The local database and Docker daemon were unavailable; no local database was
created or reset, and no service was started. PostgreSQL validation is delegated
to the repository's existing CI service. Local checks and final CI results are
reported with the implementation PR.

No real model was called. False factual premises can still retrieve related text;
retrieval does not decide truth. Abstention depends on model adherence, and the
existing output safety check is not a fact checker. Section expansion can reduce
recall for oversized sections. Cross-section dependencies need appropriate content
authoring; there is no new per-claim evidence model. Formal content review and all
default production/augmentation gates remain unchanged.

The implementation is isolated from the primary workspace's uncommitted frontend,
diary and prompt work. It does not enable knowledge augmentation in the running app.
