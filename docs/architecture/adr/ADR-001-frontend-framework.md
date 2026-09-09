# ADR-001: Frontend Framework

- Status: Accepted
- Date: 2026-09-09

## Context

V1 is a responsive Web application with a separately deployed API. The first phase is engineering bootstrap, not SEO-heavy public content.

## Decision

Use **React 19 + Vite 8 + TypeScript**. Keep routing and server-state libraries out of Bootstrap until concrete screens require them. Reserve `src/locales/zh-CN.json` from day one for future i18n.

## Why this fits

- Very small mental model for a single full-stack developer.
- Cleanly preserves the required frontend/backend separation.
- Fast development/build tooling and straightforward static deployment.
- React ecosystem gives a future path to React Native without coupling the Web application to a full-stack framework.

## Alternatives

### Next.js

Strong routing, SSR and full-stack conventions.

**Not selected now:** the project already requires a separate backend API, while most V1 screens are authenticated application UI. Adding Next.js server/runtime concepts would duplicate backend boundaries without a current SEO/SSR requirement.

### Vue + Vite / Nuxt

Both are credible and productive.

**Not selected now:** the project benefits more from one TypeScript/React ecosystem and broad commercial hiring/library support than from introducing a second architectural style.

## Future impact

React/Vite does not block adding a public SSR/SSG marketing site later. If SEO-heavy public content becomes a real requirement, it can be evaluated as a separate frontend concern without rewriting the API.
