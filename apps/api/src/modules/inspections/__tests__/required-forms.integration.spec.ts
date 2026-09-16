import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  ensureRequiredForms,
  requiredFormsState,
  canonicalItems,
  TEMPLATE_VERSION,
  TEMPLATE_NAME,
} from '../templates/required-forms';

/**
 * CR-2026-107 §14 — the deployment-parity regression suite.
 *
 * These run against a REAL database because the defect they guard against is a
 * database-state defect: the manager's deployment had the tables (migrations ran)
 * and no template rows (the seed never did). A mock cannot fail that way, which is
 * precisely why the bug survived a green test suite for several releases.
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgresql://... \
 *     pnpm --filter @bsop/api exec vitest run required-forms.integration
 *
 * Every test starts by deleting ONLY the two template kinds and rebuilding the
 * state under test, so the suite is safe to point at a scratch deployment. It
 * never touches customers, visits or inspections except the ones it creates.
 */
const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)('required forms bootstrap (DB)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => prisma.$connect());
  afterAll(async () => {
    // Leave the database usable for whatever runs next.
    await ensureRequiredForms(prisma).catch(() => undefined);
    await prisma.$disconnect();
  });

  /** The manager's starting point: tables present, no inspection templates at all. */
  async function wipeTemplates(): Promise<void> {
    await prisma.inspectionTemplateItem.deleteMany({});
    await prisma.inspectionTemplate.deleteMany({});
  }

  beforeEach(wipeTemplates);

  // --- Fresh site -----------------------------------------------------------
  it('a brand-new empty database gets all three required forms', async () => {
    const before = await requiredFormsState(prisma);
    expect(before.serviceInspection).toBe(false);
    expect(before.preJobInspection).toBe(false);

    const { state, changed } = await ensureRequiredForms(prisma);

    expect(changed).toBe(true);
    expect(state).toEqual({ jobSheet: true, preJobInspection: true, serviceInspection: true });
  });

  // --- Different site UUID --------------------------------------------------
  it('does not depend on any site id — the templates are shop-wide, not per-site', async () => {
    await ensureRequiredForms(prisma);

    // The model itself is the guarantee: if a siteId column ever appears on
    // InspectionTemplate, this test fails and the CR-2026-107 reasoning must be
    // revisited rather than silently broken.
    const [row] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM inspection_templates LIMIT 1`,
    );
    expect(Object.keys(row)).not.toContain('site_id');

    // And the runtime lookup resolves with a site that has never been seen before.
    const unknownSite = '00000000-0000-4000-8000-0000000000ff';
    const found = await prisma.inspectionTemplate.findFirst({
      where: { isActive: true, kind: 'VEHICLE_INSPECTION', items: { some: {} } },
      orderBy: { version: 'desc' },
    });
    expect(found, `a template must resolve regardless of site ${unknownSite}`).toBeTruthy();
  });

  // --- Rerun ----------------------------------------------------------------
  it('running the bootstrap twice creates no duplicates and reports no changes', async () => {
    await ensureRequiredForms(prisma);
    const second = await ensureRequiredForms(prisma);

    expect(second.changed).toBe(false);
    expect(second.actions).toEqual([]);

    const counts = await prisma.inspectionTemplate.groupBy({ by: ['kind'], _count: { _all: true } });
    for (const c of counts) expect(c._count._all, `${c.kind} must not be duplicated`).toBe(1);
    expect(await prisma.inspectionTemplateItem.count()).toBe(canonicalItems().length);
  });

  // --- Missing one template -------------------------------------------------
  it('heals a deployment that has the pre-inspection but lost the vehicle inspection', async () => {
    await ensureRequiredForms(prisma);
    await prisma.inspectionTemplateItem.deleteMany({});
    await prisma.inspectionTemplate.deleteMany({ where: { kind: 'VEHICLE_INSPECTION' } });

    const { actions, state } = await ensureRequiredForms(prisma);

    expect(state.serviceInspection).toBe(true);
    expect(state.preJobInspection).toBe(true);
    expect(actions.map((a) => a.form)).toContain('Service Inspection');
    expect(actions.map((a) => a.form)).not.toContain('Pre-Job Inspection');
  });

  // --- Missing two templates ------------------------------------------------
  it('heals a deployment missing BOTH inspection templates (the reported defect)', async () => {
    const { actions, state } = await ensureRequiredForms(prisma);

    expect(state.serviceInspection).toBe(true);
    expect(state.preJobInspection).toBe(true);
    expect(actions.filter((a) => a.action === 'created')).toHaveLength(2);
  });

  it('reactivates a template that exists but was deactivated', async () => {
    await ensureRequiredForms(prisma);
    await prisma.inspectionTemplate.updateMany({ data: { isActive: false } });

    const { actions, state } = await ensureRequiredForms(prisma);

    expect(state.serviceInspection && state.preJobInspection).toBe(true);
    expect(actions.every((a) => a.action === 'activated')).toBe(true);
  });

  it('restores a checklist that lost its items', async () => {
    await ensureRequiredForms(prisma);
    await prisma.inspectionTemplateItem.deleteMany({});

    const { actions, state } = await ensureRequiredForms(prisma);

    expect(state.serviceInspection).toBe(true);
    expect(actions.some((a) => a.action === 'checklist-restored')).toBe(true);
    expect(await prisma.inspectionTemplateItem.count()).toBe(canonicalItems().length);
  });

  it('stands down an itemless newer version that would shadow the good one', async () => {
    await ensureRequiredForms(prisma);
    await prisma.inspectionTemplate.create({
      data: { kind: 'VEHICLE_INSPECTION', version: TEMPLATE_VERSION + 1, name: 'Empty v2', isActive: true },
    });
    // Precondition: the runtime lookup is now broken.
    expect((await requiredFormsState(prisma)).serviceInspection).toBe(false);

    const { actions, state } = await ensureRequiredForms(prisma);

    expect(state.serviceInspection).toBe(true);
    expect(actions.some((a) => a.action === 'unshadowed')).toBe(true);
    // Deactivated, never deleted — inspections performed against it keep their pin.
    const v2 = await prisma.inspectionTemplate.findFirst({ where: { version: TEMPLATE_VERSION + 1, kind: 'VEHICLE_INSPECTION' } });
    expect(v2?.isActive).toBe(false);
  });

  // --- Existing Job Sheet ---------------------------------------------------
  it('leaves the Job Sheet alone — it is code-defined and never templated', async () => {
    const draftsBefore = await prisma.jobSheetDraft.count();

    const { state } = await ensureRequiredForms(prisma);

    expect(state.jobSheet).toBe(true);
    expect(await prisma.jobSheetDraft.count()).toBe(draftsBefore);
    // The bootstrap must never invent a template for it.
    const kinds = await prisma.inspectionTemplate.findMany({ select: { kind: true } });
    expect(new Set(kinds.map((k) => k.kind))).toEqual(new Set(['VEHICLE_INSPECTION', 'PRE_INSPECTION']));
  });

  // --- Active query ---------------------------------------------------------
  it('satisfies the EXACT query the application runs when a form is opened', async () => {
    await ensureRequiredForms(prisma);

    // Copied from inspections.service.ts create(). If that predicate changes and
    // this is not updated, the suite fails rather than the shop.
    for (const kind of ['VEHICLE_INSPECTION', 'PRE_INSPECTION'] as const) {
      const template = await prisma.inspectionTemplate.findFirst({
        where: { isActive: true, kind, ...(kind === 'VEHICLE_INSPECTION' ? { items: { some: {} } } : {}) },
        orderBy: { version: 'desc' },
        include: { items: { orderBy: { orderIndex: 'asc' } } },
      });
      expect(template, `${kind} must resolve for the create path`).toBeTruthy();
      if (kind === 'VEHICLE_INSPECTION') {
        expect(template!.items).toHaveLength(canonicalItems().length);
        expect(template!.name).toBe(TEMPLATE_NAME);
        // Order is the paper form's order — technicians read down the page.
        expect(template!.items.map((i) => i.orderIndex)).toEqual(canonicalItems().map((i) => i.orderIndex));
      }
    }
  });

  // --- Historical version ---------------------------------------------------
  it('leaves completed inspections pinned to the template version they were performed against', async () => {
    await ensureRequiredForms(prisma);
    const v1 = await prisma.inspectionTemplate.findFirstOrThrow({
      where: { kind: 'VEHICLE_INSPECTION', version: TEMPLATE_VERSION },
    });

    // A historical inspection needs a visit to hang off. Create a disposable one
    // rather than borrowing real records — this assertion is the whole point of
    // the test and must never silently degrade on an empty deployment.
    const site = await prisma.site.findFirstOrThrow({ select: { id: true } });
    const tag = `cr107-${Date.now()}`;
    const customer = await prisma.customer.create({
      data: { customerNumber: `TEST-${tag}`, firstName: 'CR107', lastName: 'Fixture', phone: '0000000000' },
      select: { id: true },
    });
    const vehicle = await prisma.vehicle.create({
      data: { customerId: customer.id, vehicleCode: `SC-${tag}`, plateNumber: tag.slice(-8).toUpperCase() },
      select: { id: true },
    });
    const visit = await prisma.serviceVisit.create({
      data: { siteId: site.id, customerId: customer.id, vehicleId: vehicle.id, sourceType: 'WALKIN' },
      select: { id: true, siteId: true, vehicleId: true, customerId: true },
    });

    const insp = await prisma.vehicleInspection.create({
      data: {
        inspectionNumber: `INS-TEST-${Date.now()}`,
        siteId: visit.siteId,
        serviceVisitId: visit.id,
        vehicleId: visit.vehicleId,
        customerId: visit.customerId,
        templateId: v1.id,
        templateVersion: TEMPLATE_VERSION,
        kind: 'VEHICLE_INSPECTION',
        status: 'DRAFT',
        items: { create: [{ category: 'Battery', label: 'Historical line', orderIndex: 0, result: 'OK' }] },
      },
      include: { items: true },
    });

    try {
      // A later template upgrade lands...
      await prisma.inspectionTemplate.create({
        data: { kind: 'VEHICLE_INSPECTION', version: TEMPLATE_VERSION + 1, name: 'Empty v2', isActive: true },
      });
      await ensureRequiredForms(prisma);

      const after = await prisma.vehicleInspection.findUniqueOrThrow({
        where: { id: insp.id },
        include: { items: true },
      });
      // ...and the completed record is untouched: same template, same version,
      // same snapshotted lines.
      expect(after.templateId).toBe(v1.id);
      expect(after.templateVersion).toBe(TEMPLATE_VERSION);
      expect(after.items).toHaveLength(1);
      expect(after.items[0].label).toBe('Historical line');
      expect(await prisma.inspectionTemplate.count({ where: { id: v1.id } })).toBe(1);
    } finally {
      await prisma.inspectionItem.deleteMany({ where: { inspectionId: insp.id } });
      await prisma.vehicleInspection.delete({ where: { id: insp.id } });
      await prisma.serviceVisit.delete({ where: { id: visit.id } });
      await prisma.vehicle.delete({ where: { id: vehicle.id } });
      await prisma.customer.delete({ where: { id: customer.id } });
    }
  });
});
