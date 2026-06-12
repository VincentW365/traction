import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SandboxContextService } from '../../common/sandbox/sandbox-context.service';
import { createSandboxTaggingMiddleware } from '../../common/sandbox/sandbox-tagging.middleware';

/**
 * PrismaService is the $extends-wrapped client (CR-2026-023). The sandbox query
 * extension is a no-op unless a dev-login sandbox run is in context, so normal
 * requests and background jobs are unaffected. Manifest writes + ownership reads
 * go through the BASE (un-extended) client, so they never re-enter the extension
 * (no recursion). Prisma 6 removed `$use`, so this uses a query-component extension.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  constructor(sandbox: SandboxContextService) {
    const base = new PrismaClient();

    const middleware = createSandboxTaggingMiddleware({
      getRunId: () => sandbox.getRunId(),
      writeManifestRef: async (entityType, entityId, runId) => {
        try {
          await base.externalSystemRef.create({
            data: {
              system: 'TEST_DATA_RUN',
              entityType,
              entityId,
              externalId: runId,
              syncStatus: 'SYNCED',
              metadata: { devLoginSession: true },
            },
          });
        } catch (e: unknown) {
          // ignore a duplicate manifest ref (unique system+entityType+entityId)
          if ((e as { code?: string })?.code !== 'P2002') throw e;
        }
      },
      isOwned: async (model, id, runId) => {
        const delegate = (base as unknown as Record<
          string,
          { findUnique: (a: unknown) => Promise<{ testDataRunId?: string | null } | null> }
        >)[model.charAt(0).toLowerCase() + model.slice(1)];
        const row = await delegate.findUnique({ where: { id }, select: { testDataRunId: true } });
        return row?.testDataRunId === runId;
      },
    });

    const extended = base.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            return middleware(
              { model, action: operation, args: args as Record<string, unknown> },
              (p) => query(p.args as typeof args),
            );
          },
        },
      },
    });

    return Object.assign(extended, {
      async onModuleInit() {
        await base.$connect();
      },
      async onModuleDestroy() {
        await base.$disconnect();
      },
    }) as unknown as PrismaService;
  }

  // Real implementations attached at runtime via Object.assign in the constructor.
  onModuleInit!: () => Promise<void>;
  onModuleDestroy!: () => Promise<void>;
}

// Declaration-merge PrismaClient so an injected `PrismaService` keeps full client
// typing while the runtime instance is the $extends-wrapped client.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PrismaService extends PrismaClient {}
