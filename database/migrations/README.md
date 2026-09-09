# Database migrations

This directory is managed by Drizzle Kit.

- Generate migrations with `pnpm db:generate`.
- Review generated SQL before committing it.
- Apply migrations with `pnpm db:migrate`.
- Do not use `drizzle-kit push` as the normal schema-change workflow.
- Do not modify Production schema manually.
