# Architecture Decision Records

Accepted decisions:

1. ADR-001 Frontend Framework
2. ADR-002 Backend Framework
3. ADR-003 PostgreSQL Data Access / ORM
4. ADR-004 Authentication Strategy
5. ADR-005 Monorepo Tooling
6. ADR-006 LLM Provider Architecture
7. ADR-007 Logging Strategy
8. ADR-008 Testing Strategy
9. ADR-009 Environment Configuration Strategy
10. ADR-010 Docker / Local Development Strategy
11. ADR-011 Identity and Access Lifecycle
12. ADR-012 Conversation, Retention and Quota Data Model
13. ADR-013 AI Provider and Streaming Architecture
14. ADR-014 AI Safety and Crisis Response Architecture
15. ADR-015 User-Facing Conversation, Incognito, and Client Data Boundaries
16. ADR-016 Consent Lifecycle and Policy Evidence
17. ADR-017 Mood Tracking and Minimal Profile Data Boundaries
18. ADR-018 Knowledge Base Content and Publication Boundaries
19. ADR-019 LLM Knowledge Retrieval and Citation Boundaries
20. ADR-020 Admin Identity and Least-Privilege Backend Boundaries

Proposed decisions:

- None

New decisions should use the next sequential ADR number. Existing accepted ADRs should not be silently rewritten; supersede them with a new ADR when the decision materially changes.

ADR-016 narrowly supersedes ADR-011's Consent single-lifecycle/no-reaccept rule
and ADR-015's broad all-user withdrawal cleanup rule. All other decisions in
ADR-011 and ADR-015 remain Accepted.
