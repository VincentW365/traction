# CR-2026-047 — Dev sandbox sessions get full feature access (temporary, dev-only)

**Status:** IMPLEMENTED. **Type:** Auth-surface change (dev-login/sandbox only) — owner-directed for manual testing. Recorded here as the §9 review artifact.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"When I do the sandbox logins some features are not available. Let all features be available but only temporary. I'm going to start testing manually today and want to see how the app stacks up against real operations."

## 2. Cause
A dev-login (sandbox) session signs a normal token for the mapped role, so it carries **only that role's permissions** (`ROLE_PERMISSIONS[role]`), and the web app gates features by `roleCode`. No single role is a superset — e.g. the technician **My Work** nav is `roles: ['TECHNICIAN']` and is hidden even from ADMIN; reports/admin pages are ADMIN/MANAGER-only — so every sandbox login was missing some features.

## 3. Change — sandbox = full access, temporary, dev-only
A **dev sandbox session** (one that carries a `sandboxRunId`) now gets full access on both layers, while the **selected role is preserved for identity/audit/display**:

- **API — `auth.service.ts` `signAccessToken()`**: when `sandboxRunId` is present **and** `devLoginEnabled()` is true, the token's `permissions` claim is the full set (`ROLE_PERMISSIONS.ADMIN`). The `role`/`sub` claims stay the real dev user (audit unchanged). Applies on dev-login **and** on refresh (sessions refresh every 15 min). Real logins (no `sandboxRunId`) are completely unchanged.
- **Web — `hooks/use-auth.ts`**: in a sandbox session the in-memory `user.roleCode` is presented as `ADMIN` for gating (covers all role-gated pages, which all include ADMIN). The actually-selected role is retained in `sandboxRole` for display.
- **Web — `components/sidebar.tsx`**: a sandbox session shows **all** nav items (covers nav that is role-exclusive of ADMIN, e.g. technician My Work). The footer shows the picked role + an amber "· full access" marker so the tester always knows which role they chose.

## 4. Security boundary (why this is safe)
- `sandboxRunId` is set **only** by `devLogin()`, which is gated by `devLoginEnabled()` = `ALLOW_DEV_LOGIN === 'true'` **and** `NODE_ENV !== 'production'`. Dev-login is refused in production regardless of the flag.
- The full-access grant **re-checks `devLoginEnabled()`** as defense-in-depth: even if a sandbox token reached a production instance, refresh would mint a normal role-scoped token (covered by a test).
- Tokens are JWT-signed; a client cannot self-assign `sandboxRunId`.
- Normal `login()` never sets `sandboxRunId` → production/real users are unaffected. Records created during a sandbox session remain tagged to the `DEV_LOGIN_SESSION` run and are cleanable via the existing sandbox cleanup.

## 5. Files
- `apps/api/src/modules/auth/auth.service.ts` — full-access permissions for sandbox tokens (gated).
- `apps/api/src/modules/auth/__tests__/dev-login.spec.ts` — updated MANAGER case (full perms, role preserved); added refresh-preserves-access and disabled-gate defense-in-depth tests.
- `apps/web/hooks/use-auth.ts` — effective ADMIN role for sandbox gating; `sandboxRole` retained.
- `apps/web/components/sidebar.tsx` — show all nav in sandbox; footer shows picked role + "full access".
- `docs/69_CR_2026_047_Sandbox_Full_Access.md` (this file).

## 6. Verification
- API typecheck green; API `vitest run` green — **65 files / 513 tests** (auth suite incl. the new sandbox-access cases; normal-login still asserts role-scoped permissions).
- Web typecheck green; route-smoke green (66/66).
- Manual: dev-login as any role → every sidebar section visible (incl. technician My Work, Reports, Admin), every page loads, role-gated actions available; footer shows e.g. "front desk · full access". Normal login still role-limited.

## 7. Governance
Auth-surface change → §9 review trigger. Scope is **dev-login/sandbox only**, env-gated, temporary per session, and does not touch production or real-login auth. Owner-directed for a manual test pass. Recorded as a CR; reversible via git (remove the sandbox branch to restore role-scoped sandbox tokens).
