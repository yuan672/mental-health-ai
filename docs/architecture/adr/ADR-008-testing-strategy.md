# ADR-008: Testing Strategy

- Status: Accepted
- Date: 2026-09-09

## Context
Bootstrap must provide unit-test foundations while later phases require strong safety testing for risk classification, diagnosis refusal and crisis behavior.

## Decision
Use:
- **Jest + Nest testing utilities + Supertest** for API unit/integration tests;
- **Vitest + React Testing Library** for Web component/unit tests;
- **Playwright** later for a small number of P0 browser end-to-end flows;
- dedicated table-driven safety cases in Phase 4.

CI runs lint, typecheck, unit/integration tests and build on pull requests.

## Why this fits
- Uses the most conventional test path for Nest and the Vite-native path for Web.
- Supertest validates real HTTP contracts without an external server.
- Playwright is deferred until there is a meaningful browser flow, avoiding empty E2E ceremony.

## Alternatives
### One test runner everywhere
Aesthetically simpler.

**Not selected now:** forcing one runner across Nest and Vite gives little user value and may require extra transforms/configuration. Root scripts already hide runner differences.

### E2E-heavy strategy
Can catch integration bugs.

**Not selected now:** expensive and brittle before product flows exist. Most safety/domain rules should be fast deterministic tests.

## Future impact
Phase 4 must treat safety cases as release-blocking tests. Provider network calls should be mocked/faked in normal CI; separate controlled integration checks may run against real providers.
