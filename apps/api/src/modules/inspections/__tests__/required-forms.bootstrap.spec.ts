import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequiredFormsBootstrap } from '../required-forms.bootstrap';

/**
 * CR-2026-107 — the startup guarantee.
 *
 * The defect being regression-tested is NOT "the seed produces bad templates" —
 * it never did. It is "nothing in the deployed application made sure the seed had
 * ever run". So these tests assert the guarantee exists, runs at start, survives a
 * failure without taking the site down, and stays wired into the module.
 */
function build(over: { ensure?: () => Promise<unknown> } = {}) {
  const prisma = {} as never;
  const bootstrap = new RequiredFormsBootstrap(prisma);
  const logger = {
    log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
  };
  (bootstrap as unknown as { logger: typeof logger }).logger = logger;
  return { bootstrap, logger };
}

const ROOT = join(__dirname, '..');

describe('RequiredFormsBootstrap (CR-2026-107)', () => {
  const saved = process.env.FORMS_BOOTSTRAP;
  beforeEach(() => { delete process.env.FORMS_BOOTSTRAP; });
  afterEach(() => { if (saved === undefined) delete process.env.FORMS_BOOTSTRAP; else process.env.FORMS_BOOTSTRAP = saved; });

  it('runs on application bootstrap, not on request', async () => {
    const { bootstrap } = build();
    const run = vi.spyOn(bootstrap, 'run').mockResolvedValue(undefined);
    await bootstrap.onApplicationBootstrap();
    expect(run).toHaveBeenCalledOnce();
  });

  it('can be disabled for a read-only replica with FORMS_BOOTSTRAP=off', async () => {
    const { bootstrap, logger } = build();
    process.env.FORMS_BOOTSTRAP = 'off';
    const run = vi.spyOn(bootstrap, 'run').mockResolvedValue(undefined);
    await bootstrap.onApplicationBootstrap();
    expect(run).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/not guaranteed/));
  });

  it('never throws out of startup — a form problem must not boot-loop the whole site', async () => {
    const { bootstrap, logger } = build();
    // Prisma is an empty object here, so ensureRequiredForms will throw.
    await expect(bootstrap.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/forms:ensure/));
  });

  /**
   * A static guard. Wiring is the whole fix: if the provider is dropped from the
   * module, the guarantee silently disappears again and every other test here
   * would still pass.
   */
  it('is registered as a provider on InspectionsModule', () => {
    const mod = readFileSync(join(ROOT, 'inspections.module.ts'), 'utf8');
    expect(mod).toContain('RequiredFormsBootstrap');
    expect(mod).toMatch(/providers:\s*\[[^\]]*RequiredFormsBootstrap/s);
  });

  /**
   * The canonical definition must stay in the application source, not in prisma/.
   * That relocation IS the fix — prisma/ is not deployed as application code, and
   * an environment that skips the seed never executes anything under it.
   */
  it('reads its definition from the application source, and prisma/ delegates to it', () => {
    const data = readFileSync(join(ROOT, '..', '..', '..', '..', '..', 'prisma', 'inspection-template-data.ts'), 'utf8');
    expect(data).toContain('apps/api/src/modules/inspections/templates/required-forms');
    // No second copy of the checklist anywhere.
    expect(data).not.toContain('Head Lights / Tail Lights');
  });
});
