/**
 * CR-2026-107 — the canonical definition of the operational forms a deployed
 * Service Centre cannot run without, and the single idempotent routine that
 * guarantees they exist.
 *
 * WHY THIS LIVES IN apps/api/src (and not in prisma/)
 * --------------------------------------------------
 * The forms kept going missing on the manager's deployment while working here.
 * The templates were never the problem: they were reproducible from `prisma/`
 * all along. What was missing is that EVERY guarantee lived outside the code
 * that actually gets deployed — `render.yaml`'s build command, a deploy script,
 * a runbook. A Render service whose Build Command was edited in the dashboard
 * (Render then stops reading render.yaml for that service), or a database
 * restored after the last build, silently skips all of them, and the API comes
 * up serving traffic with no inspection templates at all.
 *
 * So the guarantee moved INTO the application: `RequiredFormsBootstrap` calls
 * `ensureRequiredForms` on every API start. Nothing an operator can detach or
 * forget now sits between a deployment and a usable inspection form.
 * `prisma/inspection-template-data.ts` delegates here, so the seed, the API, the
 * health endpoint and `pnpm forms:ensure` all read ONE definition.
 *
 * SITE SCOPING — deliberately none.
 * `InspectionTemplate` has no `siteId` column (see prisma/schema.prisma): a
 * template is a shop-wide form definition, and an inspection records its site on
 * the VehicleInspection row instead. That is why nothing here resolves or writes
 * a site id, and why no environment's site UUID can ever be baked in. The
 * runtime lookup filters on kind + isActive only — never on site.
 *
 * HISTORY — never rewritten.
 * A completed inspection snapshots its lines into `InspectionItem` and pins
 * `templateId` + `templateVersion` on the `VehicleInspection` row. Template rows
 * are only ever created or reactivated here, never deleted, so historical
 * inspections keep pointing at exactly the template version used to perform them.
 */
import type { PrismaClient } from '@prisma/client';

/** Version of the checklist-bearing vehicle/service inspection template. */
export const TEMPLATE_VERSION = 1;
export const TEMPLATE_NAME = 'Visual Inspection Form v1';

/** The photo-first pre-job inspection. Itemless by design — see CATEGORIES note. */
export const PRE_INSPECTION_VERSION = 1;
export const PRE_INSPECTION_NAME = 'Pre-Inspection v1';

/**
 * Source of truth for the checklist: docs/56_Visual_Inspection_Form.md (the
 * 3-state checklist lines of the paper form this replaces).
 */
export const CATEGORIES: Array<{ category: string; items: Array<{ label: string; allowsNa?: boolean }> }> = [
  {
    category: 'Interior / Exterior',
    items: [
      { label: 'Head Lights / Tail Lights / Turn Signals / Brake Lights / Hazard Warning Lights / Exterior Lamps / License Plate Lights' },
      { label: 'Windshield Washer Spray / Wiper Operation / Wiper Blades' },
      { label: 'Windshield Condition (inspect for cracks, chips, or pitting)' },
      { label: 'Mirrors / Glass' },
      { label: 'Emergency Brake Adjustment' },
      { label: 'Horn Operation' },
      { label: 'Fuel Tank Cap Gasket' },
      { label: 'Air Conditioning Filter (if equipped)', allowsNa: true },
      { label: 'Clutch Operation (if equipped)', allowsNa: true },
      { label: 'Back-up Lights Left / Right' },
      { label: 'Dash Warning Lights' },
      { label: 'Carpet / Upholstery / Floor Mats' },
    ],
  },
  {
    category: 'Battery',
    items: [
      { label: 'Battery Terminals / Cables / Mountings' },
      { label: 'Check Condition of Battery (storage capacity test)' },
    ],
  },
  {
    category: 'Under Vehicle',
    items: [
      { label: 'Shock Absorbers / Suspension / Struts' },
      { label: 'Steering Gear Box / Linkage and Boots / Ball Joints / Dust Covers' },
      { label: 'Muffler / Exhaust Pipes / Mountings / Catalytic Converter' },
      { label: 'Engine Oil and/or Fluid Leaks' },
      { label: 'Brake Lines / Hoses / Parking Brake Cable' },
      { label: 'Drive Shaft Boots / CV Boots / U-joints / Transmission Linkage (if equipped)', allowsNa: true },
      { label: 'Transmission / Differential / Transfer Case (check fluid level, condition, leaks)' },
      { label: 'Fuel Lines and Connections / Fuel Tank Band / Fuel Tank Vapor Vent System Hoses' },
      { label: 'Inspect Nuts and Bolts on Body Chassis' },
    ],
  },
  {
    category: 'Under Hood',
    items: [
      { label: 'Fluid Levels: Oil / Coolant / Battery / Power Steering / Brake / Washer / Automatic Transmission' },
      { label: 'Engine Air Filter' },
      { label: 'Drive Belts (condition and adjustment)' },
      { label: 'Cooling System Hoses / Heater Hoses / A/C Hoses and Connections' },
      { label: 'Radiator Core / A/C Condenser (if equipped)', allowsNa: true },
      { label: 'Coolant Recovery Reservoir Fluid Level / Condition' },
      { label: 'Clutch Reservoir Fluid / Condition (as equipped)', allowsNa: true },
    ],
  },
];

/** The canonical checklist, flattened to the rows stored per template. */
export function canonicalItems(): Array<{ category: string; label: string; orderIndex: number; allowsNa: boolean }> {
  const rows: Array<{ category: string; label: string; orderIndex: number; allowsNa: boolean }> = [];
  let orderIndex = 0;
  for (const group of CATEGORIES) {
    for (const item of group.items) {
      rows.push({ category: group.category, label: item.label, orderIndex: orderIndex++, allowsNa: !!item.allowsNa });
    }
  }
  return rows;
}

export interface RequiredFormsState {
  /** An active VEHICLE_INSPECTION template whose HIGHEST active version has >= 1 item. */
  serviceInspection: boolean;
  /** An active PRE_INSPECTION template (itemless by design). */
  preJobInspection: boolean;
  /** Code-defined (JobSheetDraft) — true once migrations have created its table. */
  jobSheet: boolean;
}

/**
 * The EXACT predicate the API applies when a form is opened
 * (`inspections.service.ts` create): per kind, the highest-version ACTIVE
 * template, and for the vehicle inspection that row must carry items. The seed,
 * the startup bootstrap, deploy-check and /health all call this, so "seeded" can
 * never disagree with "works".
 */
export async function requiredFormsState(prisma: PrismaClient): Promise<RequiredFormsState> {
  const [vi, pre] = await Promise.all([
    prisma.inspectionTemplate.findFirst({
      where: { isActive: true, kind: 'VEHICLE_INSPECTION' },
      orderBy: { version: 'desc' },
      select: { id: true, _count: { select: { items: true } } },
    }),
    prisma.inspectionTemplate.findFirst({
      where: { isActive: true, kind: 'PRE_INSPECTION' },
      orderBy: { version: 'desc' },
      select: { id: true },
    }),
  ]);
  let jobSheet = true;
  try {
    await prisma.jobSheetDraft.count();
  } catch {
    jobSheet = false;
  }
  return {
    serviceInspection: !!vi && vi._count.items > 0,
    preJobInspection: !!pre,
    jobSheet,
  };
}

/** What `ensureRequiredForms` had to do, for the deploy log and the operator. */
export interface EnsureAction {
  form: 'Service Inspection' | 'Pre-Job Inspection';
  action: 'created' | 'activated' | 'checklist-restored' | 'renamed' | 'unshadowed';
  detail: string;
}

export interface EnsureRequiredFormsResult {
  /** Empty when the deployment was already correct — the healthy, silent case. */
  actions: EnsureAction[];
  changed: boolean;
  state: RequiredFormsState;
}

/**
 * Bring a database to the point where all required inspection forms can be
 * opened. Idempotent, non-destructive and safe on a live deployment:
 *
 *   - creates a missing template (with its checklist);
 *   - reactivates one that exists but was deactivated;
 *   - restores the checklist of a template that has lost its items;
 *   - deactivates an itemless HIGHER-version active vehicle template that would
 *     otherwise shadow a good one at runtime;
 *   - does nothing at all when the deployment is already correct.
 *
 * It never deletes a template, never touches a VehicleInspection, an
 * InspectionItem, a visit or any customer data, and never writes a site id.
 *
 * Throws if the forms are still unusable afterwards — a caller must never be
 * told the deployment is fine when it is not.
 */
export async function ensureRequiredForms(prisma: PrismaClient): Promise<EnsureRequiredFormsResult> {
  const actions: EnsureAction[] = [];
  const wanted = canonicalItems();

  await prisma.$transaction(async (tx) => {
    // --- A. The vehicle / service inspection (checklist-bearing) ---
    const vi = await tx.inspectionTemplate.findUnique({
      // Versions are unique per KIND (CR-2026-093): the vehicle checklist and the
      // pre-inspection number their revisions independently.
      where: { kind_version: { kind: 'VEHICLE_INSPECTION', version: TEMPLATE_VERSION } },
      select: { id: true, name: true, isActive: true, _count: { select: { items: true } } },
    });

    if (!vi) {
      const created = await tx.inspectionTemplate.create({
        data: { version: TEMPLATE_VERSION, name: TEMPLATE_NAME, isActive: true, kind: 'VEHICLE_INSPECTION' },
        select: { id: true },
      });
      await tx.inspectionTemplateItem.createMany({
        data: wanted.map((i) => ({ ...i, templateId: created.id })),
      });
      actions.push({
        form: 'Service Inspection',
        action: 'created',
        detail: `v${TEMPLATE_VERSION} created and activated with ${wanted.length} checklist items`,
      });
    } else {
      if (!vi.isActive) {
        await tx.inspectionTemplate.update({ where: { id: vi.id }, data: { isActive: true } });
        actions.push({ form: 'Service Inspection', action: 'activated', detail: `v${TEMPLATE_VERSION} was inactive — reactivated` });
      }
      if (vi.name !== TEMPLATE_NAME) {
        await tx.inspectionTemplate.update({ where: { id: vi.id }, data: { name: TEMPLATE_NAME } });
        actions.push({ form: 'Service Inspection', action: 'renamed', detail: `"${vi.name}" -> "${TEMPLATE_NAME}"` });
      }
      // Only rebuild the checklist when it is actually wrong. A template whose
      // items already match is left completely untouched, so a rerun writes
      // nothing and an operator reading the log sees a genuinely quiet deploy.
      if (vi._count.items !== wanted.length || !(await checklistMatches(tx, vi.id, wanted))) {
        await tx.inspectionTemplateItem.deleteMany({ where: { templateId: vi.id } });
        await tx.inspectionTemplateItem.createMany({ data: wanted.map((i) => ({ ...i, templateId: vi.id })) });
        actions.push({
          form: 'Service Inspection',
          action: 'checklist-restored',
          detail: `checklist had ${vi._count.items} item(s) — restored to the canonical ${wanted.length}`,
        });
      }
    }

    // --- B. The pre-job inspection (photo-first, deliberately itemless) ---
    const pre = await tx.inspectionTemplate.findUnique({
      where: { kind_version: { kind: 'PRE_INSPECTION', version: PRE_INSPECTION_VERSION } },
      select: { id: true, name: true, isActive: true },
    });
    if (!pre) {
      await tx.inspectionTemplate.create({
        data: { version: PRE_INSPECTION_VERSION, name: PRE_INSPECTION_NAME, isActive: true, kind: 'PRE_INSPECTION' },
      });
      actions.push({ form: 'Pre-Job Inspection', action: 'created', detail: `v${PRE_INSPECTION_VERSION} created and activated` });
    } else {
      if (!pre.isActive) {
        await tx.inspectionTemplate.update({ where: { id: pre.id }, data: { isActive: true } });
        actions.push({ form: 'Pre-Job Inspection', action: 'activated', detail: `v${PRE_INSPECTION_VERSION} was inactive — reactivated` });
      }
      if (pre.name !== PRE_INSPECTION_NAME) {
        await tx.inspectionTemplate.update({ where: { id: pre.id }, data: { name: PRE_INSPECTION_NAME } });
        actions.push({ form: 'Pre-Job Inspection', action: 'renamed', detail: `"${pre.name}" -> "${PRE_INSPECTION_NAME}"` });
      }
    }

    // --- C. Never let an itemless newer version shadow a good one ---
    // The runtime lookup reads the TOP active version only, so an active v2 with
    // no items makes the form unopenable even though v1 is perfect. Deactivate
    // it (never delete: inspections performed against it keep their pin).
    const shadowing = await tx.inspectionTemplate.findMany({
      where: { kind: 'VEHICLE_INSPECTION', isActive: true, version: { gt: TEMPLATE_VERSION }, items: { none: {} } },
      select: { id: true, version: true, name: true },
    });
    for (const s of shadowing) {
      await tx.inspectionTemplate.update({ where: { id: s.id }, data: { isActive: false } });
      actions.push({
        form: 'Service Inspection',
        action: 'unshadowed',
        detail: `"${s.name}" v${s.version} was active with no checklist items and would have hidden v${TEMPLATE_VERSION} — deactivated`,
      });
    }
  });

  // Verify with the RUNTIME predicate, not with the rows we think we just wrote.
  const state = await requiredFormsState(prisma);
  if (!state.serviceInspection || !state.preJobInspection) {
    throw new Error(
      'Required inspection forms are still not usable after the bootstrap — ' +
        `Service Inspection: ${state.serviceInspection ? 'ok' : 'MISSING'}, ` +
        `Pre-Job Inspection: ${state.preJobInspection ? 'ok' : 'MISSING'}. Refusing to report success.`,
    );
  }
  return { actions, changed: actions.length > 0, state };
}

/** True when the stored checklist is exactly the canonical one, in order. */
async function checklistMatches(
  tx: Pick<PrismaClient, 'inspectionTemplateItem'>,
  templateId: string,
  wanted: ReturnType<typeof canonicalItems>,
): Promise<boolean> {
  const have = await tx.inspectionTemplateItem.findMany({
    where: { templateId },
    orderBy: { orderIndex: 'asc' },
    select: { category: true, label: true, orderIndex: true, allowsNa: true },
  });
  if (have.length !== wanted.length) return false;
  return wanted.every(
    (w, i) =>
      have[i].category === w.category &&
      have[i].label === w.label &&
      have[i].orderIndex === w.orderIndex &&
      have[i].allowsNa === w.allowsNa,
  );
}
