/**
 * Jobs / Visits historical importer (CR-2026-005).
 *
 *   (default)            DRY-RUN — counts-only report to demo-output/. NO DB writes, NO raw comments.
 *   --commit             Write TERMINAL historical ServiceVisit/ServiceOrder (+ tech assignments,
 *                        pause/rework ledgers, refs). Batch-tagged, idempotent by job external ref.
 *   --rollback <batchId> Delete a committed batch.
 *   --file <path>        default ./jobs.csv
 *
 * Guardrails: terminal historical only — NO queue tickets, NO scheduler/recompute/rank/ETA/bay,
 * NO notifications, NO active statuses. Ledgers are audit-only. Source/PII git-ignored.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  rawJobFromCsv, mapJob, resolutionKind, normalizeTechName, buildJobDryRunReport,
  type PlannedJob, type JobImportStats,
} from '../src/modules/data-import/job-visit.mapper';

const JOB_SYSTEM = 'SHAREPOINT_JOB_SHEET' as const;
const OUT_DIR = 'demo-output';
const PLACEHOLDER_CUSTOMER_NUMBER = 'BERT-HIST-UNKNOWN';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = has('--rollback') ? 'rollback' : has('--commit') ? 'commit' : 'dry-run';
const FILE = val('--file') ?? 'jobs.csv';
const ROLLBACK_ID = val('--rollback');

function parseCsv(s: string): Record<string, string>[] {
  const rows: string[][] = []; let f: string[] = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) { const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { f.push(cur); cur = ''; }
    else if (c === '\r') {} else if (c === '\n') { f.push(cur); rows.push(f); f = []; cur = ''; } else cur += c; }
  if (cur !== '' || f.length) { f.push(cur); rows.push(f); }
  const h = rows[0];
  return rows.slice(1).filter((r) => r.length >= h.length - 3 && r.some((x) => x !== '')).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

function loadJobs(): PlannedJob[] {
  return parseCsv(readFileSync(FILE, 'utf8')).filter((r) => (r['Id'] ?? '').trim()).map(rawJobFromCsv).map(mapJob);
}

async function buildContext(prisma: PrismaClient) {
  const refs = await prisma.externalSystemRef.findMany({ where: { system: 'SHAREPOINT_CONTACT_DB' as any, entityType: 'Vehicle' }, select: { externalId: true, entityId: true } });
  const vehicles = await prisma.vehicle.findMany({ where: { id: { in: refs.map((r) => r.entityId) } }, select: { id: true, customerId: true } });
  const custByVeh = new Map(vehicles.map((v) => [v.id, v.customerId]));
  const resolve = new Map<string, { vehicleId: string; customerId: string }>();
  for (const r of refs) { const c = custByVeh.get(r.entityId); if (c) resolve.set(r.externalId, { vehicleId: r.entityId, customerId: c }); }
  const techs = await prisma.technician.findMany({ select: { id: true, userAccount: { select: { fullName: true } } } });
  const techByName = new Map<string, string>();
  for (const t of techs) { const n = normalizeTechName(t.userAccount?.fullName ?? ''); if (n) techByName.set(n, t.id); }
  const site = await prisma.site.findFirst({ select: { id: true } });
  return { resolve, techByName, siteId: site?.id ?? null };
}

function computeStats(jobs: PlannedJob[], ctx: { resolve: Map<string, any>; techByName: Map<string, string> }): JobImportStats {
  let resolved = 0, unresolvedLinked = 0, unlinked = 0, completed = 0, cancelled = 0, stale = 0;
  let vClosed = 0, vCancelled = 0, techTotal = 0, techRes = 0, techUnres = 0, pauses = 0, rework = 0, mileageSuspect = 0;
  for (const j of jobs) {
    const kind = resolutionKind(j.customerNoId, j.customerNoId ? ctx.resolve.has(j.customerNoId) : false);
    if (kind === 'RESOLVED') resolved++; else if (kind === 'UNRESOLVED_LINKED') unresolvedLinked++; else unlinked++;
    const ss = j.sourceStatus.toLowerCase();
    if (ss === 'completed') completed++; else if (ss === 'cancelled') cancelled++; else stale++;
    if (j.visitStatus === 'CANCELLED') vCancelled++; else vClosed++;
    for (const t of j.techNames) { techTotal++; if (ctx.techByName.has(normalizeTechName(t))) techRes++; else techUnres++; }
    if (j.pause) pauses++;
    if (j.rework) rework++;
    if (j.mileageSuspect) mileageSuspect++;
  }
  return {
    sourceFile: FILE, rows: jobs.length, resolved, unresolvedLinked, unlinked,
    placeholdersNeeded: unresolvedLinked + unlinked,
    statusCompleted: completed, statusCancelled: cancelled, staleImportedAsTerminal: stale,
    visitClosed: vClosed, visitCancelled: vCancelled,
    techAssignments: techTotal, techResolved: techRes, techUnresolved: techUnres,
    pauses, rework, mileageSuspect,
  };
}

async function dryRun() {
  const prisma = new PrismaClient();
  try {
    const jobs = loadJobs();
    const ctx = await buildContext(prisma);
    const stats = computeStats(jobs, ctx);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'jobs-dryrun-summary.md'), buildJobDryRunReport(stats), 'utf8');
    console.warn(`\nJOBS DRY-RUN complete — NO DB writes.`);
    console.warn(`  jobs=${stats.rows}  resolved=${stats.resolved}  unresolvedLinked=${stats.unresolvedLinked}  unlinked=${stats.unlinked}  placeholders=${stats.placeholdersNeeded}`);
    console.warn(`  visit CLOSED/CANCELLED=${stats.visitClosed}/${stats.visitCancelled}  stale→terminal=${stats.staleImportedAsTerminal}`);
    console.warn(`  techAssign resolved/unres=${stats.techResolved}/${stats.techUnresolved}  pauses=${stats.pauses}  rework=${stats.rework}  mileageSuspect=${stats.mileageSuspect}`);
    console.warn(`  report -> ${OUT_DIR}/jobs-dryrun-summary.md (counts only)\n`);
  } finally { await prisma.$disconnect(); }
}

// --- COMMIT (terminal historical; NOT run until dry-run approved) ---
async function commit() {
  const prisma = new PrismaClient();
  const jobs = loadJobs();
  const batchId = randomUUID();
  try {
    const ctx = await buildContext(prisma);
    if (!ctx.siteId) throw new Error('No site found');

    // Shared placeholder customer for unresolved/unlinked jobs.
    const placeholder = await prisma.customer.upsert({
      where: { customerNumber: PLACEHOLDER_CUSTOMER_NUMBER },
      update: {},
      create: { customerNumber: PLACEHOLDER_CUSTOMER_NUMBER, firstName: '', lastName: 'Historical — Unknown Customer', phone: 'N/A', notificationOptInSms: false, notificationOptInEmail: false, notes: 'UNRESOLVED_HISTORICAL_PLACEHOLDER — exclude from customer-quality metrics' },
    });

    const existingRefs = await prisma.externalSystemRef.findMany({ where: { system: JOB_SYSTEM as any, entityType: 'ServiceVisit' }, select: { externalId: true, entityId: true } });
    const visitByJob = new Map(existingRefs.map((r) => [r.externalId, r.entityId]));
    let visits = 0;

    for (const j of jobs) {
      const kind = resolutionKind(j.customerNoId, j.customerNoId ? ctx.resolve.has(j.customerNoId) : false);
      let customerId: string, vehicleId: string;
      if (kind === 'RESOLVED') { const m = ctx.resolve.get(j.customerNoId!)!; customerId = m.customerId; vehicleId = m.vehicleId; }
      else {
        customerId = placeholder.id;
        const ph = await prisma.vehicle.upsert({
          where: { vehicleCode: `HIST-UNRESOLVED-${j.jobId}` },
          update: { customerId },
          create: { customerId, vehicleCode: `HIST-UNRESOLVED-${j.jobId}`, plateNumber: '' },
        });
        vehicleId = ph.id;
      }

      const visitNotes = `[hist source_status=${j.sourceStatus}; resolution=${kind}] ${j.notes}`.trim();
      const visitData = {
        siteId: ctx.siteId, customerId, vehicleId, sourceType: 'HISTORICAL_IMPORT' as any,
        status: j.visitStatus as any, arrivalAt: j.visitDate, checkedInAt: j.visitDate,
        createdAt: j.visitDate ?? undefined, mileageIn: j.mileageIn ?? undefined,
        oilBrandRequested: j.oil ?? undefined, notes: visitNotes,
      };
      const existingVisitId = visitByJob.get(j.jobId);
      const visit = existingVisitId
        ? await prisma.serviceVisit.update({ where: { id: existingVisitId }, data: visitData })
        : await prisma.serviceVisit.create({ data: visitData });

      // One ServiceOrder per visit (terminal). Reconcile children idempotently.
      const existingOrder = await prisma.serviceOrder.findFirst({ where: { serviceVisitId: visit.id }, select: { id: true } });
      const orderData = { status: j.orderStatus as any, startedAt: j.startedAt, completedAt: j.completedAt, closedAt: j.visitStatus === 'CLOSED' ? j.completedAt : undefined, notes: j.notes || undefined };
      const order = existingOrder
        ? await prisma.serviceOrder.update({ where: { id: existingOrder.id }, data: orderData })
        : await prisma.serviceOrder.create({ data: { serviceVisitId: visit.id, ...orderData } });

      await prisma.technicianAssignment.deleteMany({ where: { serviceOrderId: order.id } });
      await prisma.serviceOrderPause.deleteMany({ where: { serviceOrderId: order.id } });
      await prisma.serviceOrderRework.deleteMany({ where: { serviceOrderId: order.id } });

      for (const t of j.techNames) {
        const techId = ctx.techByName.get(normalizeTechName(t));
        if (!techId) continue;
        await prisma.technicianAssignment.create({ data: { serviceOrderId: order.id, technicianId: techId, status: 'COMPLETED', startedAt: j.startedAt, endedAt: j.completedAt } });
      }
      if (j.pause) await prisma.serviceOrderPause.create({ data: { serviceOrderId: order.id, reasonCode: 'OTHER', startedAt: j.pause.startedAt, endedAt: j.pause.endedAt } });
      if (j.rework) await prisma.serviceOrderRework.create({ data: { serviceOrderId: order.id, reasonCode: 'HISTORICAL_RECTIFY', openedAt: j.rework.openedAt, closedAt: j.rework.closedAt } });

      await prisma.externalSystemRef.upsert({
        where: { system_entityType_entityId: { system: JOB_SYSTEM as any, entityType: 'ServiceVisit', entityId: visit.id } },
        update: { externalId: j.jobId, syncStatus: 'SYNCED' }, // preserve original batch lineage
        create: { system: JOB_SYSTEM as any, entityType: 'ServiceVisit', entityId: visit.id, externalId: j.jobId, syncStatus: 'SYNCED', metadata: { importBatchId: batchId, jobId: j.jobId, resolution: kind, sourceStatus: j.sourceStatus } },
      });
      visits++;
    }
    console.warn(`\nJOBS COMMIT complete (batch ${batchId}): visits=${visits}`);
    console.warn(`  rollback: tsx apps/api/scripts/import-jobs.ts --rollback ${batchId}\n`);
  } finally { await prisma.$disconnect(); }
}

async function rollback(batchId: string) {
  const prisma = new PrismaClient();
  try {
    const refs = await prisma.externalSystemRef.findMany({ where: { system: JOB_SYSTEM as any, entityType: 'ServiceVisit' } });
    const batchRefs = refs.filter((r) => (r.metadata as any)?.importBatchId === batchId);
    const visitIds = [...new Set(batchRefs.map((r) => r.entityId))];
    const orders = await prisma.serviceOrder.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    await prisma.technicianAssignment.deleteMany({ where: { serviceOrderId: { in: orderIds } } });
    await prisma.serviceOrderPause.deleteMany({ where: { serviceOrderId: { in: orderIds } } });
    await prisma.serviceOrderRework.deleteMany({ where: { serviceOrderId: { in: orderIds } } });
    await prisma.serviceOrder.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.externalSystemRef.deleteMany({ where: { id: { in: batchRefs.map((r) => r.id) } } });
    await prisma.serviceVisit.deleteMany({ where: { id: { in: visitIds } } });
    // Placeholder vehicles created by this batch (orphaned) + placeholder customer if empty.
    await prisma.vehicle.deleteMany({ where: { vehicleCode: { startsWith: 'HIST-UNRESOLVED-' }, serviceVisits: { none: {} } } });
    const ph = await prisma.customer.findUnique({ where: { customerNumber: PLACEHOLDER_CUSTOMER_NUMBER }, include: { vehicles: true, serviceVisits: true } });
    if (ph && ph.vehicles.length === 0 && ph.serviceVisits.length === 0) await prisma.customer.delete({ where: { id: ph.id } });
    console.warn(`\nJOBS ROLLBACK batch ${batchId}: removed ${visitIds.length} visits, ${orderIds.length} orders, ${batchRefs.length} refs.\n`);
  } finally { await prisma.$disconnect(); }
}

(async () => {
  if (MODE === 'dry-run') await dryRun();
  else if (MODE === 'commit') await commit();
  else { if (!ROLLBACK_ID) { console.error('--rollback requires a batchId'); process.exit(1); } await rollback(ROLLBACK_ID); }
})().catch((e) => { console.error(e); process.exit(1); });
