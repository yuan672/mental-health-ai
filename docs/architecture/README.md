# Architecture

The project uses a Modular Monolith: one Web application, one API application, shared workspace packages, and one PostgreSQL database.

Architecture decisions are recorded under `docs/architecture/adr/`. The handoff
document remains the product and engineering baseline. Current phase and production
control status is summarized in `docs/PROJECT_CONTROL_HANDOFF.md`.

Operational architecture designs and bounded runbooks include:

- [`local-synthetic-database-backup-restore-drill.md`](local-synthetic-database-backup-restore-drill.md) —
  documentation-only NF-04 plan for a future isolated synthetic PostgreSQL drill;
  no backup or restore has been executed.
