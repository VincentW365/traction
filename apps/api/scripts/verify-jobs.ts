/** Jobs import verification (CR-2026-005). Read-only. Usage: tsx verify-jobs.ts [batchId] */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const batchId = process.argv[2];

(async () => {
  const [
    queueTickets, notifications, visitTotal, visitHistorical, orders, assignments, pauses, rework,
    jobRefs, customers, vehicles, placeholderVehicles, visitClosed, visitCancelled,
  ] = await Promise.all([
    prisma.queueTicket.count(),
    prisma.notificationLog.count(),
    prisma.serviceVisit.count(),
    prisma.serviceVisit.count({ where: { sourceType: 'HISTORICAL_IMPORT' as any } }),
    prisma.serviceOrder.count(),
    prisma.technicianAssignment.count(),
    prisma.serviceOrderPause.count(),
    prisma.serviceOrderRework.count(),
    prisma.externalSystemRef.count({ where: { system: 'SHAREPOINT_JOB_SHEET' as any } }),
    prisma.customer.count(),
    prisma.vehicle.count(),
    prisma.vehicle.count({ where: { vehicleCode: { startsWith: 'HIST-UNRESOLVED-' } } }),
    prisma.serviceVisit.count({ where: { sourceType: 'HISTORICAL_IMPORT' as any, status: 'CLOSED' as any } }),
    prisma.serviceVisit.count({ where: { sourceType: 'HISTORICAL_IMPORT' as any, status: 'CANCELLED' as any } }),
  ]);

  console.warn('=== JOBS VERIFY ===');
  console.warn(`SIDE-EFFECT GUARDS  queueTickets=${queueTickets}  notificationLogs=${notifications}`);
  console.warn(`ServiceVisit total=${visitTotal} | HISTORICAL_IMPORT=${visitHistorical} (CLOSED ${visitClosed} / CANCELLED ${visitCancelled})`);
  console.warn(`ServiceOrder=${orders}  TechnicianAssignment=${assignments}  Pause=${pauses}  Rework=${rework}`);
  console.warn(`Job ExternalSystemRef (SHAREPOINT_JOB_SHEET)=${jobRefs}`);
  console.warn(`Customer total=${customers}  Vehicle total=${vehicles}  placeholderVehicles=${placeholderVehicles}`);

  const ph = await prisma.customer.findUnique({ where: { customerNumber: 'BERT-HIST-UNKNOWN' }, include: { _count: { select: { vehicles: true, serviceVisits: true } } } });
  console.warn(`Placeholder customer present=${!!ph}${ph ? ` (vehicles=${ph._count.vehicles}, visits=${ph._count.serviceVisits})` : ''}`);

  if (batchId) {
    const refs = await prisma.externalSystemRef.findMany({ where: { system: 'SHAREPOINT_JOB_SHEET' as any }, select: { metadata: true } });
    const inBatch = refs.filter((r) => (r.metadata as any)?.importBatchId === batchId).length;
    console.warn(`Batch ${batchId}: ${inBatch} job refs`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
