# ADR-009: Environment Configuration Strategy

- Status: Accepted
- Date: 2026-09-09

## Context
Development, Staging and Production must use independent databases, keys, secrets and logs. Git may contain `.env.example` but not real `.env` files or secrets.

## Decision
Use environment variables as the only runtime configuration source.

- Root `.env.example` documents variables with non-secret local placeholders.
- Local developers copy it to untracked `.env`.
- API validates required variables with **Zod at startup** and fails fast.
- Vite reads only explicitly public `VITE_*` values; backend secrets must never use a `VITE_` prefix.
- CI/deployment injects Staging/Production values through environment/secret stores.
- Environment name is `development | staging | production`.
- Do not commit environment-specific secret files.

## Why this fits
- Simple twelve-factor-style deployment model.
- Fail-fast validation prevents silent misconfiguration.
- Public/private prefixes make frontend secret leakage harder.
- Does not force a cloud-specific secret manager during Bootstrap.

## Alternatives
### Checked-in per-environment config files
Convenient for non-secret settings.

**Not selected now:** easy to blur the boundary between public configuration and secrets and conflicts with the handoff's environment-variable rule.

### Cloud secret manager SDK in application code
Useful in production.

**Not selected now:** no deployment platform has been selected; runtime-injected environment variables keep the application portable.

## Future impact
A deployment platform may source variables from a managed secret store without changing application code. Development/Staging/Production must remain separate datasets and credentials.
