# ADR-003: Custom JWT Auth with Provider-Agnostic RBAC for Pilot

## Status
Proposed

## Context
BSOP requires authentication for ~15 staff users across 8 roles with 47 permissions. The system is an internal staff tool for a single-site pilot. Customer self-service login is deferred to Phase 2+. `claude.md` specifies "provider-agnostic OIDC/JWT boundary with RBAC enforced in API."

## Decision
Implement **custom JWT authentication** with bcrypt password hashing, role-based access control via guard decorators, and a provider-agnostic auth interface that allows future swap to Auth0/Keycloak/OIDC.

### Schema change
Add `password_hash` column (nullable text) to `user_accounts` table. This column is not in the original `db/schema_outline.sql` blueprint.

## Options Considered
1. **Custom JWT** — no external dependency, full control, simplest for internal pilot
2. **Auth0** — full OIDC, social login, MFA, good docs
3. **Keycloak** — self-hosted OIDC, free, complete RBAC
4. **Clerk** — modern DX, good Next.js integration

## Rationale
- Pilot has ~15 known staff users at one site. External auth adds network dependency and cost with no proportional benefit.
- The `auth_subject` field already exists on `user_accounts` — it will hold the external OIDC subject ID when a provider is added later.
- RBAC enforcement is identical regardless of auth provider: the JWT payload contains `userId`, `roleCode`, `siteId`, and permission claims. The `@RequirePermission()` decorator and `RbacGuard` check these claims.
- The provider-agnostic boundary means swapping to Auth0/Keycloak requires only: (1) replace JWT issuance with OIDC JWKS verification, (2) map external subject to `auth_subject`, (3) RBAC layer unchanged.

## Tradeoffs
- **Gain:** Zero external dependency, no network calls for auth, full control over token structure, cheapest option, fastest to implement
- **Lose:** Must handle password storage (bcrypt), no SSO/MFA in Phase 1, no social login, must build login UI
- **Risk:** Password handling must be secure (bcrypt cost 12, constant-time comparison). Acceptable for controlled internal pilot.

## Impact
- **Schema:** `password_hash` column added to `user_accounts` (AG-02 triggered)
- **Modules:** Auth module in `apps/api/src/modules/auth/`
- **Endpoints:** POST /auth/login, POST /auth/refresh, GET /auth/me
- **Guards:** JwtAuthGuard, RbacGuard, SiteGuard in `apps/api/src/common/guards/`
- **Frontend:** Login page, auth context, JWT storage in memory (not localStorage)
- **Seed:** Test users seeded with bcrypt-hashed passwords

## Rollback / Migration
Migration to OIDC provider:
1. Configure OIDC provider (Auth0/Keycloak)
2. Create users in provider, map to `auth_subject` on `user_accounts`
3. Replace `JwtStrategy` to verify tokens via JWKS endpoint instead of local secret
4. Remove `password_hash` column (or leave nullable)
5. RbacGuard and SiteGuard: zero changes
6. Frontend: replace login form with OIDC redirect flow

## Approval Gate
AG-05 (choosing not to add external auth dependency). AG-07 (security/permission model). AG-02 (password_hash column addition).
