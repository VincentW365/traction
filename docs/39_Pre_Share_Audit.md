# 39 — Pre-Share / Pre-Remote Audit

**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** Audit only — read-only review. No cleanup performed yet.
**Purpose:** Capture the repo's state and the risks/checklist to resolve **before** a remote is configured or the branch is shared. This document does not change code or git state.

---

## 1. Current repo state
- Branch: `master` only. **No remote configured** (`git remote -v` empty). Single linear history, 24 commits (`7fe3837` → `211e252`).
- Working tree clean except local agent config: `.claude/settings.local.json` (modified, **tracked**) and `.claude/settings.json` (untracked). See §6.
- Quality gates (verified 2026-06-10): API `tsc --noEmit` exit 0; **235/235** API tests pass; Web `tsc --noEmit` exit 0.
- Docs chain complete: `docs/00`–`38` (+ this `39`); CR records `25`–`38`; approval gates `docs/21`.

## 2. Tags / save-points (10, chronological)
`save-point-pre-ui-polish` → `save-point-post-customer-vehicle-import` → `save-point-post-contact-field-backfill` → `save-point-post-jobs-historical-import` → `save-point-post-operational-scope-filtering` → `save-point-post-eta-average-isolation` → `save-point-post-vehicle-classification` → `save-point-post-vehicle-classification-ui` → `save-point-post-classification-progress-report` → `save-point-post-pause-resume-rework-ui` (HEAD).
Each marks a coherent, individually-revertable milestone. Tags are local-only (not pushed).

## 3. Migration state
- 10 applied migrations; `prisma migrate status` → **"Database schema is up to date"**, no drift.
- Order (lexicographic = applied order):
  `20260331153143_initial_schema`, `20260401164322_add_queue_event_fifo_v2`, `20260403_v4_1_foundation`, `20260410000258_dmaic_alignment`, `20260609162547_pause_resume_rework_recording`, `20260609173013_vehicle_service_class`, `20260609190217_sharepoint_contact_db_enum`, `20260609195533_contact_field_backfill`, `20260609201902_jobs_historical_import_enums`, `20260609_cr_2026_008_vehicle_classification`.
- **Naming note (LOW):** the last folder lacks the 14-digit timestamp prefix the others use. Verified it still sorts last and applies correctly; cosmetic only — do **not** rename if it's already applied on any shared DB.
- All CR migrations are additive/non-destructive.

## 4. Import / rollback scripts (`apps/api/scripts/`)
| Script | Modes | Rollback |
|---|---|---|
| `import-customers.ts` | dry-run (default) / `--commit` / `--rollback <batchId>` | batch-tagged delete |
| `import-jobs.ts` | dry-run / `--commit` / `--rollback <batchId>` | batch-tagged delete |
| `backfill-vehicle-classifications.ts` | dry-run / `--commit` / `--rollback` | deletes only unreviewed PENDING rows; preserves CONFIRMED |
| `reseed-weight-suggestions.ts` | reseed (idempotent: deleteMany + recreate) | n/a (config table) |
| `verify-import.ts`, `verify-jobs.ts`, `verify-classification-backfill.ts` | read-only | n/a |
- Source data files these read (`customers*.csv`, `jobs*.csv`) are gitignored, so a fresh clone cannot run the imports without the (PII) source — by design.

## 5. PII / raw-data review (risks)
- **Gitignored & not tracked (good):** `.env`, `customers*.{csv,xml}`, `jobs*.{csv,xml}`, `Service Center*.csv`, `*.docx`, `*.iqy`, `demo-output/`. Verified none are tracked.
- **Tracked `data/*.csv` are project config, not PII:** `business_rules`, `queue_decision_table`, `service_catalogue`, `kpi_dictionary`, `roles_permissions_matrix`, `backlog_epics_user_stories`. Safe.
- **HIGH — Screenshots may contain real customer PII:** `screenshots/06-customers.png`, `07-customers.png`, `verify-customers.png` (data-bearing pages; also review `verify-reports`, queue/check-in shots). They were committed in `5cca4e7`, **before** the SharePoint import `b5e06c5`, so they most likely show synthetic seed data — **must be confirmed**. If any contain post-import PII, scrub/remove; note that for a *public* remote, removal alone is insufficient (the blob stays in history → history rewrite required). Resolve before any remote exists.
- **`scripts/sharepoint/analyze-jobs.mjs`** reviewed: dependency-free, reads the gitignored `jobs.csv`, no embedded names/secrets/URLs. Safe.

## 6. `.claude/*` handling (risk — MEDIUM)
- `.claude/settings.local.json` is **tracked** (machine-local agent config) and currently modified; `.claude/settings.json` is untracked; `.claude/` is **not** in `.gitignore`.
- **Risk:** local-only config (permission allowlists, paths) shipped in a shared repo; ongoing noise in `git status`.
- **Recommendation:** add `.claude/settings.local.json` (and optionally `.claude/settings.json`) to `.gitignore` and `git rm --cached` the tracked local file; or commit a sanitized shared `settings.json`. Confirm no secrets/local absolute paths inside first.

## 7. `migration_lock.toml` recommendation (MEDIUM)
- Currently **gitignored** (`prisma/migrations/**/migration_lock.toml`); exists on disk but is not committed.
- **Prisma best practice is to commit `migration_lock.toml`** — it records the datasource provider and guards against provider drift on a shared clone. Recommend removing that ignore line and tracking the lock file.

## 8. Junk artifact (MEDIUM)
- `prisma/migrations/v4_1_temp.sql` is a **tracked 3-line junk file** whose contents are a stray Prisma CLI error string ("You must pass the --shadow-database-url …"). It is not a real migration (loose file, not a migration folder; Prisma ignores it). **Recommend deleting it** during cleanup.

## 9. VIN-decode default (MEDIUM)
- `maintenance.module.ts` selects the Stub provider only when `VIN_DECODE_PROVIDER === 'STUB'`; **any unset/other value uses the LIVE NHTSA vPIC API.**
- `.env.example` sets `VIN_DECODE_PROVIDER="STUB"` and documents it, but a deploy/clone that omits the var will make outbound calls.
- **Recommendation:** invert to "live only when explicitly enabled (e.g. `=LIVE`)", or document prominently in README. (Tracks `docs/29` item 3.2.)
- Notifications default `NOTIFICATION_PROVIDER="stub"`; Twilio/SendGrid stay disabled until configured (good).

## 10. Fresh-clone reproducibility checklist
- [ ] `pnpm install`
- [ ] Copy `.env.example` → `.env` (set `DATABASE_URL`, `JWT_SECRET`, keep `VIN_DECODE_PROVIDER=STUB`)
- [ ] `pnpm db:migrate` (applies the 10 migrations)
- [ ] `pnpm db:seed` (users, technicians, weight/serviceClass suggestions, base config)
- [ ] (Optional, gated) classification backfill — **note:** the 7,157 PENDING `VehicleClassification` rows are produced by `backfill-vehicle-classifications.ts --commit`, **not** by seed; a fresh DB won't have them.
- [ ] Boot API + web; smoke-test login + one operational page.
- [ ] Add a README documenting exactly this order.
- [ ] Verify `pnpm db:reset && db:seed` yields a clean working app (no seed step assumes imported data).

## 11. ETA work status (corrected)
- **CR-2026-007 (ETA average isolation) is IMPLEMENTED** — commit `99f0ef3` `feat(queue): isolate ETA average with historical fallback`, tag `save-point-post-eta-average-isolation`. Live-by-default with historical small-sample fallback (30-day window, 20-order threshold).
- **Genuinely deferred ETA follow-ups only:** (a) **outlier trimming** (`eta_avg_outlier_cap_minutes`, deliberately deferred for v1 per `docs/34`); (b) **tuning** the 30-day window / 20-order threshold once live volume accrues.
- **Doc-accuracy cleanup (LOW):** `docs/34` status line and `docs/29` item 2.5 still read "APPROVED … not yet implemented" — **stale**; correct to "Implemented (99f0ef3)" during cleanup.

## 12. Open work to keep visible (not blockers)
- `docs/29` items: 2.2 (notification opt-in by design), 3.1 (pre-existing WIP not line-audited), 3.3 (manual SharePoint sync), 4.1–4.3 (data-quality acceptables). Ensure these travel into any handoff.

## 13. Recommended pre-remote sequence
1. **PII gate first** — confirm/scrub the customers & reports screenshots (do any history rewrite *before* a remote exists).
2. **Repo hygiene** — delete `v4_1_temp.sql`; commit `migration_lock.toml` (remove ignore line); resolve `.claude/*` (gitignore local + `git rm --cached`, or sanitized commit).
3. **Config hardening** — make VIN-decode opt-in-to-live (or document); re-confirm `.env.example` ↔ env-validation parity.
4. **Doc accuracy** — correct the stale CR-2026-007 status lines (`docs/34`, `docs/29` 2.5).
5. **Reproducibility** — run the §10 fresh-clone checklist on a scratch DB; write the README.
6. **Re-run gates** — `tsc` (api+web) + full API tests (currently green).
7. **Then** (separate, explicitly-approved steps): create a **private** remote, push `master`, decide on pushing tags, add LICENSE/README.

---
> This audit is descriptive only. Each item above is actioned during a later, separately-approved cleanup pass — no changes were made in creating this document.
