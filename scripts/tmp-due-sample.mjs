/**
 * Stage a clearly-labelled SAMPLE customer so the Due for Contact screen can be
 * seen populated. Everything is synthetic and tagged "(SAMPLE)" — remove with
 * the same script:  node scripts/tmp-due-sample.mjs --remove
 */
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;
const db = new PrismaClient();
const REMOVE = process.argv.includes('--remove');

const existing = await db.customer.findFirst({
  where: { customerNumber: 'SAMPLE-DFC' },
  include: { vehicles: true },
});

if (REMOVE) {
  if (existing) {
    for (const v of existing.vehicles) {
      await db.maintenanceRecommendation.deleteMany({ where: { vehicleId: v.id } });
      await db.vehicle.delete({ where: { id: v.id } });
    }
    await db.customer.delete({ where: { id: existing.id } });
    console.log('sample removed');
  } else console.log('nothing to remove');
  await db.$disconnect();
  process.exit(0);
}

if (existing) {
  console.log('sample already present');
  await db.$disconnect();
  process.exit(0);
}

const inTenDays = new Date();
inTenDays.setDate(inTenDays.getDate() + 10);
const overdueDate = new Date();
overdueDate.setDate(overdueDate.getDate() - 5);

const customer = await db.customer.create({
  data: {
    customerNumber: 'SAMPLE-DFC',
    firstName: 'Sample',
    lastName: 'Customer (SAMPLE)',
    phone: '876-000-0000',
    email: 'sample.dfc@example.com',
    notificationOptInSms: false,
    notificationOptInEmail: false,
    notes: 'Synthetic record staged to preview the Due for Contact screen. Safe to delete.',
  },
});

const vehicle = await db.vehicle.create({
  data: {
    customerId: customer.id,
    vehicleCode: 'SAMPLE-DFC-V1',
    plateNumber: 'SAMPLE1',
    make: 'Toyota',
    model: 'Corolla',
    modelYear: 2020,
    odometer: 49800,
    serviceClass: 'SEDAN_CLASS',
  },
});

// One due by DATE (oil change due in 10 days) …
await db.maintenanceRecommendation.create({
  data: {
    vehicleId: vehicle.id,
    serviceTypeCode: 'OIL-01',
    recommendationType: 'POST_SERVICE',
    drivingProfile: 'NORMAL',
    basisOdometer: 44800,
    basisDate: new Date(Date.now() - 80 * 24 * 3600 * 1000),
    intervalMiles: 5000,
    intervalMonths: 3,
    nextDueOdometer: 49800 + 200, // …and within 500 miles on the clock too
    nextDueDate: inTenDays,
    dueNowFlag: false,
    isDeterminable: true,
    recommendationSource: 'SAMPLE_PREVIEW',
    confidence: 'ESTIMATE',
    notes: '(SAMPLE) staged to preview Due for Contact',
  },
});

// …and one already slightly past its date, to show the urgent shade.
await db.maintenanceRecommendation.create({
  data: {
    vehicleId: vehicle.id,
    serviceTypeCode: 'TIR-01',
    recommendationType: 'ADVISORY',
    drivingProfile: 'NORMAL',
    basisDate: new Date(Date.now() - 200 * 24 * 3600 * 1000),
    intervalMonths: 6,
    nextDueDate: overdueDate,
    dueNowFlag: false,
    isDeterminable: true,
    recommendationSource: 'SAMPLE_PREVIEW',
    confidence: 'ESTIMATE',
    notes: '(SAMPLE) staged to preview Due for Contact',
  },
});

console.log('sample staged: SAMPLE-DFC / SAMPLE1 with two due recommendations');
await db.$disconnect();
