import { ForbiddenException } from '@nestjs/common';
import { FK_DELETE_ORDER, POLY_TYPES } from '../../modules/data-import/test-data/cleanup';

// Prisma 6 removed the $use middleware types; we keep an equivalent (params, next)
// contract here and adapt it at the $extends boundary in PrismaService.
export interface SandboxMiddlewareParams {
  model?: string;
  action: string;
  args?: { where?: { id?: unknown }; data?: Record<string, unknown> | unknown[] } & Record<string, unknown>;
}
export type SandboxMiddlewareNext = (params: SandboxMiddlewareParams) => Promise<unknown>;
export type SandboxMiddleware = (params: SandboxMiddlewareParams, next: SandboxMiddlewareNext) => Promise<unknown>;

/**
 * Dev-login sandbox auto-tagging + modification guard (CR-2026-023, E-c-full).
 *
 * A Prisma middleware that activates ONLY when a dev-login sandbox run is in
 * context (AsyncLocalStorage). Default — no context — is pure pass-through, so
 * normal username/password requests and background jobs are entirely unaffected.
 *
 * In a sandbox session:
 *  - create  → inject testDataRunId on the 3 column anchors, and write a
 *              ExternalSystemRef(TEST_DATA_RUN) manifest ref for any FK entity the
 *              cleanup engine knows how to delete (FK_DELETE_ORDER). Polymorphic
 *              rows (StatusHistory/AuditLog/NotificationLog) and the manifest/run
 *              tables are NEVER tagged (cleaned by entityId / are self) — this also
 *              prevents manifest-write recursion.
 *  - update/delete on a column anchor (Customer/Vehicle/ServiceVisit) → allowed only
 *              when the by-id target belongs to the active run; non-id / bulk → default-deny.
 *              Other models are NOT guarded (internal cascades like queue recompute,
 *              order status, resource occupancy must keep working).
 */

export const SANDBOX_MOD_ERROR = 'Dev Sandbox Mode can only modify sandbox-created records.';

/** Anchors carrying a real testDataRunId column. */
export const COLUMN_MODELS = new Set(['Customer', 'Vehicle', 'ServiceVisit']);
/** FK entities the cleanup engine deletes by id → safe to manifest-tag. */
export const TAGGABLE_MODELS = new Set<string>(FK_DELETE_ORDER);
/** Never touched: the manifest/run tables + polymorphic rows (cleaned by entityId). */
export const NEVER_TOUCH = new Set<string>(['ExternalSystemRef', 'TestDataRun', ...POLY_TYPES]);

const MUTATE_ACTIONS = new Set(['update', 'delete', 'updateMany', 'deleteMany']);

export interface SandboxMiddlewareDeps {
  getRunId: () => string | undefined;
  /** Write a TEST_DATA_RUN manifest ref (idempotent — ignores duplicates). */
  writeManifestRef: (entityType: string, entityId: string, runId: string) => Promise<void>;
  /** True iff the column-anchor row with this id belongs to the run. */
  isOwned: (model: string, id: string, runId: string) => Promise<boolean>;
}

function singleId(params: SandboxMiddlewareParams): string | null {
  const where = params.args?.where;
  return where && typeof where.id === 'string' ? where.id : null;
}

export function createSandboxTaggingMiddleware(deps: SandboxMiddlewareDeps): SandboxMiddleware {
  return async (params, next) => {
    const runId = deps.getRunId();
    if (!runId) return next(params); // no sandbox context → pure pass-through

    const model = params.model;
    if (!model || NEVER_TOUCH.has(model)) return next(params);

    // --- modification guard: column anchors only ---
    if (MUTATE_ACTIONS.has(params.action) && COLUMN_MODELS.has(model)) {
      const id = singleId(params);
      if (id === null) {
        // bulk or non-id mutation in a sandbox session → cannot prove ownership → deny.
        throw new ForbiddenException(SANDBOX_MOD_ERROR);
      }
      if (!(await deps.isOwned(model, id, runId))) {
        throw new ForbiddenException(SANDBOX_MOD_ERROR);
      }
      return next(params);
    }

    // --- auto-tag creates ---
    if (params.action === 'create') {
      const data = (params.args as { data?: Record<string, unknown> } | undefined)?.data;
      if (COLUMN_MODELS.has(model) && data && !Array.isArray(data) && data.testDataRunId == null) {
        data.testDataRunId = runId;
      }
      const result = (await next(params)) as { id?: unknown } | null;
      if (TAGGABLE_MODELS.has(model) && result && typeof result.id === 'string') {
        await deps.writeManifestRef(model, result.id, runId);
      }
      return result;
    }

    return next(params);
  };
}
