# ADR-003: PostgreSQL Data Access and Migrations

- Status: Accepted
- Date: 2026-09-09

## Context
PostgreSQL is fixed by the handoff. Database names should use snake_case, TypeScript camelCase, and every schema change must be a reviewed migration.

## Decision
Use **Drizzle ORM + Drizzle Kit + node-postgres (`pg`)**. Keep TypeScript schema definitions in `database/src` and committed SQL migrations in `database/migrations`.

Normal schema changes use:
1. edit typed schema;
2. `drizzle-kit generate`;
3. review generated SQL;
4. commit migration;
5. `drizzle-kit migrate`.

Do **not** use `drizzle-kit push` as the normal team/production workflow.

## Why this fits
- Keeps SQL and PostgreSQL behavior visible instead of hiding them behind a heavy abstraction.
- Strong TypeScript inference with low runtime overhead.
- Generated SQL migrations align with the handoff's requirement that schema changes be reviewable and versioned.
- Naming can explicitly map camelCase fields to snake_case columns.

## Alternatives
### Prisma
Excellent developer experience and mature migration tooling.

**Not selected now:** its schema DSL and generated client add another abstraction layer; this project benefits from learning and reviewing actual SQL migration output.

### TypeORM
Integrated with Nest and feature rich.

**Not selected now:** broader ORM magic and historical migration ergonomics are less attractive than Drizzle's SQL-first approach for this project.

## Future impact
Drizzle does not prevent hand-written SQL for advanced PostgreSQL features. If a future workload requires a dedicated query builder or data-access layer, it can be introduced behind repository/service boundaries without changing the database.
