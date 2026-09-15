import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'reflect-metadata';
import { HealthService } from '../health.service';
import { HealthController } from '../health.controller';

/**
 * CR-2026-094 — the health surface is how a deploy is verified, which makes its two
 * properties worth pinning: it must carry the build identity the platform stamped,
 * and it must never carry a secret. The second is tested the blunt way — serialize
 * the whole payload and look for what must not be there.
 */

function build(overrides: Record<string, any> = {}) {
  const prisma: any = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('_prisma_migrations')) {
        return [{ migration_name: '20260821221000_cr_2026_093_inspection_hub' }];
      }
      return [];
    }),
    customer: { count: vi.fn(async () => 6858) },
    vehicle: { count: vi.fn(async () => 8247) },
    serviceVisit: { count: vi.fn(async () => 9064) },
    serviceType: { count: vi.fn(async () => 33) },
    site: { count: vi.fn(async () => 1) },
    userAccount: { count: vi.fn(async () => 29) },
    kpiPolicy: { count: vi.fn(async () => 1) },
    kpiServiceComponent: { count: vi.fn(async () => 19) },
    inspectionTemplate: {
      count: vi.fn(async () => 1),
      // CR-2026-106 — per-kind lookup with the runtime predicate.
      findFirst: vi.fn(async (args: any) =>
        args?.where?.kind === 'PRE_INSPECTION' ? { id: 'pre-v1' } : { _count: { items: 30 } },
      ),
    },
    jobSheetDraft: { count: vi.fn(async () => 0) },
    externalSystemRef: { count: vi.fn(async () => 16212) },
    ...overrides,
  };
  return { service: new HealthService(prisma), prisma };
}

const ENV_KEYS = [
  'RENDER_GIT_COMMIT', 'BUILD_COMMIT', 'JWT_SECRET', 'DATABASE_URL',
  'ALLOW_DEV_LOGIN', 'NODE_ENV', 'API_CORS_ORIGIN',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('public health', () => {
  it('reports the build commit the platform stamped', async () => {
    process.env.RENDER_GIT_COMMIT = '4f3a9c2b1d0e8f7a6c5b4a3928170605f4e3d2c1';
    const { service } = build();
    const h = await service.publicHealth();

    expect(h.status).toBe('ok');
    expect(h.build.commit).toBe('4f3a9c2b1d0e8f7a6c5b4a3928170605f4e3d2c1');
    expect(h.build.commitShort).toBe('4f3a9c2');
    expect(h.lastMigration).toBe('20260821221000_cr_2026_093_inspection_hub');
  });

  it('falls back to BUILD_COMMIT for non-Render hosts, and to null in local dev', async () => {
    delete process.env.RENDER_GIT_COMMIT;
    process.env.BUILD_COMMIT = 'abc123400000';
    expect((await build().service.publicHealth()).build.commitShort).toBe('abc1234');

    delete process.env.BUILD_COMMIT;
    const h = await build().service.publicHealth();
    // Null, not an invented stamp: a fake build id would defeat the page's purpose.
    expect(h.build.commit).toBeNull();
  });

  it('degrades rather than throws when the database is unreachable', async () => {
    const { service } = build({
      $queryRawUnsafe: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    const h = await service.publicHealth();
    expect(h.status).toBe('degraded');
    expect(h.database).toBe('unreachable');
    // The health endpoint must answer even when the database cannot — an uptime
    // monitor that gets a 500 instead of "degraded" learns nothing.
  });

  it('exposes no secrets anywhere in the payload', async () => {
    process.env.JWT_SECRET = 'super-secret-value-that-must-never-leak-000';
    process.env.DATABASE_URL = 'postgresql://user:dbpassword@host:5432/db';
    const raw = JSON.stringify(await build().service.publicHealth());

    expect(raw).not.toContain('super-secret-value');
    expect(raw).not.toContain('dbpassword');
    expect(raw).not.toContain('postgresql://');
  });
});

describe('deployment status (admin tier)', () => {
  it('separates reference data from operational data', async () => {
    const { service } = build();
    const d = await service.deploymentStatus();

    expect(d.reference.seeded).toBe(true);
    expect(d.operational.present).toBe(true);
    expect(d.operational.customers).toBe(6858);
    expect(d.operational.vehicles).toBe(8247);
    expect(d.operational.note).toBeNull();
  });

  it('an empty customer database is a NOTE, not a failure', async () => {
    // The whole CR in one assertion: a fresh deploy with schema + seed and zero
    // customers is CORRECT and awaiting its import — not broken.
    const { service } = build({ customer: { count: vi.fn(async () => 0) } });
    const d = await service.deploymentStatus();

    expect(d.status).toBe('ok');
    expect(d.operational.present).toBe(false);
    expect(d.operational.note).toMatch(/customer import/i);
  });

  it('missing reference data reads as not seeded', async () => {
    const { service } = build({ kpiPolicy: { count: vi.fn(async () => 0) } });
    expect((await service.deploymentStatus()).reference.seeded).toBe(false);
  });

  it('reports configuration PRESENCE, never values', async () => {
    process.env.JWT_SECRET = 'super-secret-value-that-must-never-leak-000';
    process.env.DATABASE_URL = 'postgresql://user:dbpassword@host:5432/db';
    const d = await build().service.deploymentStatus();

    expect(d.configuration.jwtSecretConfigured).toBe(true);
    const raw = JSON.stringify(d);
    expect(raw).not.toContain('super-secret-value');
    expect(raw).not.toContain('dbpassword');
  });

  it('a table that does not exist yet reports null, not a crash', async () => {
    const { service } = build({
      customer: { count: vi.fn(async () => { throw new Error('relation does not exist'); }) },
    });
    const d = await service.deploymentStatus();
    expect(d.operational.customers).toBeNull();
  });
});

describe('authorisation boundary', () => {
  it('the deployment tier requires a permission; the public tier requires none', () => {
    const deployment = Reflect.getMetadata(
      'required_permission',
      HealthController.prototype.deploymentStatus,
    );
    const pub = Reflect.getMetadata('required_permission', HealthController.prototype.publicHealth);

    expect(deployment).toEqual(['config:view']);
    expect(pub).toBeUndefined();
  });
});
