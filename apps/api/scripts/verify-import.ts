/** Post-import verification (CR-2026-003). Read-only. Usage: tsx verify-import.ts <batchId> */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const batchId = process.argv[2];

(async () => {
  const tag = `import:${batchId}`;
  const allRefs = await prisma.externalSystemRef.findMany({
    where: { system: 'SHAREPOINT_CONTACT_DB' as any },
    select: { entityId: true, externalId: true, metadata: true },
  });
  const batchRefs = batchId ? allRefs.filter((r) => (r.metadata as any)?.importBatchId === batchId) : allRefs;
  const batchVehicleIds = new Set(batchRefs.map((r) => r.entityId));

  const [customers, vehicles, batchCustomers] = await Promise.all([
    prisma.customer.count(),
    prisma.vehicle.count(),
    batchId ? prisma.customer.count({ where: { notes: { contains: tag } } }) : Promise.resolve(0),
  ]);

  console.warn('=== POST-COMMIT VERIFICATION ===');
  console.warn(`Customers — total: ${customers} | this batch: ${batchCustomers}`);
  console.warn(`Vehicles  — total: ${vehicles} | this batch (distinct via refs): ${batchVehicleIds.size}`);
  console.warn(`ExternalSystemRef (SHAREPOINT_CONTACT_DB): ${allRefs.length} | this batch: ${batchRefs.length}`);

  // Data-quality spot check + CR-2026-004 backfill coverage (counts only; engine redacted).
  const ids = [...batchVehicleIds];
  const [withVin, fuel, trans, drive, eng] = await Promise.all([
    prisma.vehicle.count({ where: { id: { in: ids }, vin: { not: null } } }),
    prisma.vehicle.count({ where: { id: { in: ids }, fuelType: { not: null } } }),
    prisma.vehicle.count({ where: { id: { in: ids }, transmission: { not: null } } }),
    prisma.vehicle.count({ where: { id: { in: ids }, drivetrain: { not: null } } }),
    prisma.vehicle.count({ where: { id: { in: ids }, engineNo: { not: null } } }),
  ]);
  const loyalty = batchId ? await prisma.customer.count({ where: { notes: { contains: tag }, loyaltyNumber: { not: null } } }) : 0;
  console.warn(`Batch vehicles with VIN populated: ${withVin} / ${batchVehicleIds.size}`);
  console.warn(`Backfill coverage — loyalty:${loyalty} fuel:${fuel} transmission:${trans} drivetrain:${drive} engine_no:${eng} (engine values redacted)`);

  // Sample customer with the most vehicles (proves dedupe → 1 customer, many vehicles)
  const sample = await prisma.customer.findFirst({
    where: { notes: { contains: tag }, vehicles: { some: {} } },
    orderBy: { vehicles: { _count: 'desc' } },
    include: { vehicles: { select: { plateNumber: true, make: true, model: true, modelYear: true, vehicleCode: true, vin: true } } },
  });
  if (sample) {
    console.warn(`\nSample multi-vehicle customer: ${sample.firstName} ${sample.lastName} (${sample.customerNumber}) — ${sample.vehicles.length} vehicles, optInSms=${sample.notificationOptInSms} optInEmail=${sample.notificationOptInEmail}`);
    for (const v of sample.vehicles) console.warn(`   • ${v.modelYear ?? '?'} ${v.make ?? ''} ${v.model ?? ''} | plate ${v.plateNumber || '(none)'} | vin ${v.vin ?? '(none)'} | ${v.vehicleCode}`);
  }

  // Join sanity: one ref resolves to exactly one vehicle (future job-import key)
  if (batchRefs[0]) {
    const veh = await prisma.vehicle.findUnique({ where: { id: batchRefs[0].entityId }, select: { vehicleCode: true } });
    console.warn(`\nJoin check: contactId ${batchRefs[0].externalId} -> vehicle ${veh?.vehicleCode ?? 'MISSING'}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
