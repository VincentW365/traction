# CR-2026-066 — One-command deploy + AI-agent deploy runbook (AGENTS.md)

**Status:** Implemented.
**Requested by:** Vincent Wilson — "My boss uses AI for deployments — is there a nudge in here to have the AI component pull the code and do the necessary seeding and redeployment when he pulls from GitHub?"

## A. Objective
Give an automated / AI deployment agent an unambiguous, single-command, idempotent path to make a
fresh `git pull` live — including the required seeding — so nothing (new deps, migrations, technician
skills, inspection template, config keys) gets missed.

## B. Change
- **`package.json`** — new root script:
  `deploy` = `pnpm install --frozen-lockfile && pnpm exec prisma generate && pnpm run db:migrate && pnpm run build && pnpm run db:seed`.
  One idempotent command covering install (picks up new deps like `@nestjs/schedule`) → prisma
  generate → migrate deploy → build → seed. Process restart stays environment-specific.
- **`AGENTS.md`** (new, repo root) — the AI-agent-discoverable runbook: the one command, what each
  step does, the process-restart step, required env vars, health checks, the Render note, and
  rollback. States plainly that **seed is idempotent, safe on a live DB, and required** (it's how
  technician skills / the active inspection template / new config keys land on an existing database),
  and that **Redis is not required**.
- **`DEPLOYMENT.md`** — a callout at the top pointing humans + agents to `pnpm run deploy` / `AGENTS.md`.

## C. Safety
`pnpm run db:seed` was verified non-destructive to operational data: the only reset is the
`vehicle_weight_suggestions` reference lookup (immediately recreated); customers/visits/queue/orders/
occupancy are create-if-missing / upsert. Migrations are additive.

## D. Impacted files
- `package.json` (script only), `AGENTS.md` (new), `DEPLOYMENT.md` (pointer),
  `docs/87_CR_2026_066_Deploy_Automation_Nudge.md`.
- No app code, no schema change.

## E. Tests / validation
- `package.json` parses; `deploy` references existing scripts (`db:migrate`, `build`, `db:seed`) —
  all present. (The command itself is a standard install/build/migrate/seed chain; not executed as
  part of this change since each step was exercised earlier this session.)

## F. Approval gate
Tooling/docs only; no schema/RBAC/logic change → **not a §9 trigger**. Recorded as a Change Request;
reversible via git.
