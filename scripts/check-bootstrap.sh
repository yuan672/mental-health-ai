#!/usr/bin/env bash
set -euo pipefail

pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
