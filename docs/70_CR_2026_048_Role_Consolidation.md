# CR-2026-048 — Role model consolidation

**Status:** IMPLEMENTED. **Type:** RBAC / auth-model change — owner-directed. §9 review trigger; this doc is the review artifact.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
- Remove the **Transport Coordinator** role.
- **Admin and Manager** are the same role — one full-access role under one name.
- **Service Advisor and Front Desk** are the same role — one role under one name.
- Remove **Parts Staff** — parts is a system function, not a dedicated role.

## 2. Decisions (owner-confirmed)
- Merged full-access role is named **"Manager"**.
- Merged front-office role is named **"Service Advisor"**.
- The 3 existing Parts Staff (2) + Transport Coordinator (1) accounts: **deleted**.

## 3. Final role model
Four roles only:
| Code (internal) | Display label | Access |
|---|---|---|
| `ADMIN` | **Manager** | Full system access |
| `SERVICE_ADVISOR` | **Service Advisor** | Front office: customers, check-in, appointments, queue, service orders, **parts**, **transport** |
| `TECHNICIAN` | Technician | Workshop |
| `CUSTOMER` | Customer | Non-staff (status pages only; not assignable) |

Implementation note: to keep the change low-risk on a 60+ file surface, the internal `roleCode`s **`ADMIN`** and **`SERVICE_ADVISOR`** are retained as the two surviving staff codes, surfaced in the UI as "Manager" and "Service Advisor" via `ROLE_LABELS`. `MANAGER`, `FRONT_DESK`, `PARTS_STAFF`, `TRANSPORT_COORDINATOR` are removed.

Permissions were preserved, not weakened: `SERVICE_ADVISOR_PERMISSIONS` already included all of `FRONT_DESK_PERMISSIONS` **plus** `PARTS_MANAGE` + `TRANSPORT_MANAGE`; `ADMIN` already = every permission (a superset of the old `MANAGER`). So no access was lost in the merges, and **parts/transport remain working system functions** (just no dedicated role).

## 4. Changes
### Backend
- `common/constants/permissions.ts` — `ROLE_PERMISSIONS` reduced to `{ CUSTOMER, SERVICE_ADVISOR, TECHNICIAN, ADMIN }`; removed the `MANAGER`/`PARTS_STAFF`/`TRANSPORT_COORDINATOR` permission blocks. Added `STAFF_ROLE_CODES` + `ROLE_LABELS` (single source of truth).
- `modules/auth/dev-login-profiles.ts` — 3 profiles (Manager/ADMIN, Service Advisor, Technician); dropped parts/transport/front-desk/manager.
- `modules/staff/dto/{create,update}-staff.dto.ts` — assignable roles = `['ADMIN','SERVICE_ADVISOR','TECHNICIAN']`.
- `modules/status/status.controller.ts`, `modules/customers/customers.controller.ts`, `scripts/confirm-classifications.ts`, `data-import/test-data/runner.ts` — role-code checks updated to `ADMIN` / `ADMIN,SERVICE_ADVISOR`.
- `scripts/seed-dev-users.ts` — comment only (derives from profiles).

### Frontend
- `components/sidebar.tsx` — nav `roles` arrays collapsed to `ADMIN` / `SERVICE_ADVISOR` / `TECHNICIAN`; sidebar shows all in sandbox (unchanged); footer label via the picked role.
- Page gates updated across `inspections/[id]`, `queue/[id]`, `complaints`, `complaints/[id]`, `reports`, `reports/service-mix`, `reports/due-for-contact`, `customers`, and `components/unclassified-alert.tsx`.
- Staff admin (`admin/staff/page.tsx`, `[id]`, `new`) + dev-login page — labels/dropdowns show Manager / Service Advisor / Technician.
- `hooks/use-auth.ts` sandbox override stays `ADMIN` (the full-access code) — unchanged.

### Data migration (`scripts/migrate-role-consolidation.ts`, run with `--commit`)
- Reassigned **MANAGER → ADMIN** (2) and **FRONT_DESK → SERVICE_ADVISOR** (2).
- **Deleted** the 3 Parts Staff / Transport Coordinator accounts (all seed/DEVTEST). To preserve audit ROWS and avoid FK breakage, every nullable `UserAccount` FK pointing at a deleted user was set NULL first (audit logs kept, actor link removed).
- Result: **ADMIN 3, SERVICE_ADVISOR 4, TECHNICIAN 18** (was ADMIN 1 / MANAGER 2 / SERVICE_ADVISOR 2 / FRONT_DESK 2 / PARTS_STAFF 2 / TRANSPORT_COORDINATOR 1 / TECHNICIAN 18).
- A full `pg_dump` backup was taken first (`backups/bsop_dev_pre_role_consolidation_*.sql`, not committed).

## 5. Verification
- API typecheck green; API `vitest run` green — **65 files / 513 tests** (updated dev-login + payment-release specs for the new role set).
- Web typecheck green; route-smoke green (66/66).
- DB role counts confirmed post-migration; deletions removed only the 3 seed/DEVTEST accounts.

## 6. Governance
RBAC/auth-model change → §9 trigger; owner-directed and confirmed. No permission was weakened (merges are supersets); no audit requirement weakened (audit rows preserved, actor link nulled only for deleted seed users). Reversible: restore from the pre-migration `pg_dump`; the removed role permission blocks are recoverable from git. The archived Transport feature (CR-2026-040) retains its `TRANSPORT_COORDINATOR` references for if/when it is restored.
