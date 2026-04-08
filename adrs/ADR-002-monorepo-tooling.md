# ADR-002: Turborepo + pnpm Monorepo with Vitest Test Framework

## Status
Proposed

## Context
BSOP is a monorepo with 2 apps (`apps/web`, `apps/api`) and 5 shared packages (`packages/types`, `packages/ui`, `packages/config`, `packages/eslint-config`, `packages/tsconfig`). The project needs build caching, parallel task orchestration, and a test framework compatible with TypeScript strict mode and ESM.

## Decision
Use **Turborepo** with **pnpm workspaces** for monorepo management and **Vitest** for unit and integration testing.

## Options Considered
### Monorepo
1. **Turborepo + pnpm** — zero-config caching, parallel pipelines, minimal config, Vercel-aligned
2. **Nx** — powerful dependency graph, generators, affected analysis
3. **Plain pnpm workspaces** — simplest, no tooling lock-in

### Testing
1. **Vitest** — fast, ESM-native, TypeScript-first, compatible with Jest APIs
2. **Jest** — mature ecosystem, larger community, but slower and ESM support is fragile

## Rationale
### Turborepo
- Single team, 2 apps, 5 packages — Turborepo's lightweight config is right-sized.
- Build caching matters because `packages/types` changes frequently during early development.
- Turbo pipeline config (`turbo.json`) is ~20 lines vs Nx's multi-file configuration.
- Nx would be justified for multiple teams or heavy use of code generators, neither of which applies.

### Vitest
- Faster execution than Jest due to native ESM and esbuild transform.
- Compatible with TypeScript strict mode without additional configuration.
- Same `describe/it/expect` API as Jest — zero learning curve.
- Works well with Testcontainers for integration tests.

## Tradeoffs
- **Gain:** Fast builds with caching, parallel lint/test/build, simple config, fast test execution
- **Lose:** No Nx-style code generators (mitigated: NestJS CLI for backend, manual for frontend). No affected-only test runs (mitigated: Turbo's content-hash-based caching achieves similar effect).

## Impact
- **Root files:** `turbo.json`, `pnpm-workspace.yaml`, `vitest.config.ts` (per app)
- **CI:** Pipeline runs `pnpm turbo build lint typecheck test`
- **Testing:** All test files use Vitest (`*.spec.ts`)

## Rollback / Migration
Migration from Turborepo to Nx requires replacing `turbo.json` with `nx.json` and updating pipeline scripts. Migration from Vitest to Jest requires changing imports and config files. Both are low-risk, localized changes.

## Approval Gate
AG-04 (architecture tooling, informational). AG-05 (new dependency, informational).
