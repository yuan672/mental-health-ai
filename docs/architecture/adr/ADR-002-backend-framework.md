# ADR-002: Backend Framework

- Status: Accepted
- Date: 2026-09-09

## Context

The backend must support a Modular Monolith, unified errors, authentication/authorization, risk modules, AI provider adapters, audit boundaries and testable modules.

## Decision

Use **NestJS 11 on Node.js 24 LTS**, with Nest's default Express adapter for Phase 1.

## Why this fits

- Modules, dependency injection, guards, interceptors and exception filters map directly to the planned modular-monolith boundaries.
- Strong conventions reduce ad-hoc controller patterns as the project grows.
- Nest's testing utilities are mature and appropriate for practicing complete engineering workflows.
- The default Express adapter minimizes platform-specific integration differences during Bootstrap and authentication work.

## Alternatives

### Fastify directly

Lean, fast and excellent for small APIs.

**Not selected now:** more architecture, dependency boundaries and error/auth conventions would have to be designed manually. The project values maintainability and learning structured backend engineering over minimizing framework code.

### NestJS with Fastify adapter

A valid future optimization.

**Not selected now:** current workload is not performance-bound, and some Nest recipes become adapter-specific. Performance should be measured before paying that complexity cost.

### FastAPI / Spring Boot

Both are production-capable.

**Not selected now:** a single TypeScript language across Web/API/shared packages gives the simplest workflow for one full-stack developer.

## Future impact

Nest modules should remain domain-oriented and must not become microservices by default. If measured HTTP throughput later becomes a bottleneck, the platform adapter can be reconsidered without changing domain services.
