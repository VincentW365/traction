/**
 * Targeted reseed of the vehicle_weight_suggestions lookup/config table only
 * (CR-2026-008). Mirrors the array in prisma/seed.ts but touches NOTHING else —
 * does not run the full seed, does not write Vehicle.serviceClass, does not
 * create VehicleClassification rows, does not touch customers/vehicles/jobs/etc.
 *
 * Advisory lookup only. Idempotent: clears + recreates the lookup rows.
 */
import { PrismaClient } from '@prisma/client';

const SUGGESTIONS = [
  { makePattern: 'Toyota', modelPattern: 'Hilux', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Toyota', modelPattern: 'Land Cruiser', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Toyota', modelPattern: 'Fortuner', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Toyota', modelPattern: 'RAV4', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Toyota', modelPattern: 'Corolla', suggestedWeightClass: 'LIGHT' as const, suggestedServiceClass: 'SEDAN_CLASS' as const },
  { makePattern: 'Toyota', modelPattern: 'Camry', suggestedWeightClass: 'LIGHT' as const, suggestedServiceClass: 'SEDAN_CLASS' as const },
  { makePattern: 'Toyota', modelPattern: 'Hiace', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Honda', modelPattern: 'Civic', suggestedWeightClass: 'LIGHT' as const, suggestedServiceClass: 'SEDAN_CLASS' as const },
  { makePattern: 'Honda', modelPattern: 'Accord', suggestedWeightClass: 'LIGHT' as const, suggestedServiceClass: 'SEDAN_CLASS' as const },
  { makePattern: 'Honda', modelPattern: 'CR-V', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Nissan', modelPattern: 'Patrol', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Nissan', modelPattern: 'Navara', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Ford', modelPattern: 'F-150', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Ford', modelPattern: 'Ranger', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Ford', modelPattern: 'Everest', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Suzuki', modelPattern: 'Swift', suggestedWeightClass: 'LIGHT' as const, suggestedServiceClass: 'SEDAN_CLASS' as const },
  { makePattern: 'Hyundai', modelPattern: 'Tucson', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Hyundai', modelPattern: 'Accent', suggestedWeightClass: 'LIGHT' as const, suggestedServiceClass: 'SEDAN_CLASS' as const },
  { makePattern: 'Mitsubishi', modelPattern: 'Triton', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Mitsubishi', modelPattern: 'Pajero', suggestedWeightClass: 'HEAVY' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Isuzu', modelPattern: 'D-Max', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Mazda', modelPattern: 'CX-5', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
  { makePattern: 'Kia', modelPattern: 'Sportage', suggestedWeightClass: 'STANDARD' as const, suggestedServiceClass: 'SUV_CLASS' as const },
];

async function main() {
  const prisma = new PrismaClient();
  try {
    const before = await prisma.vehicleWeightSuggestion.count();
    const beforeWithClass = await prisma.vehicleWeightSuggestion.count({
      where: { suggestedServiceClass: { not: null } },
    });

    await prisma.$transaction([
      prisma.vehicleWeightSuggestion.deleteMany({}),
      ...SUGGESTIONS.map((s) => prisma.vehicleWeightSuggestion.create({ data: s })),
    ]);

    const after = await prisma.vehicleWeightSuggestion.count();
    const afterWithClass = await prisma.vehicleWeightSuggestion.count({
      where: { suggestedServiceClass: { not: null } },
    });

    console.warn('--- vehicle_weight_suggestions reseed (lookup/config only) ---');
    console.warn(`rows before:                 ${before} (with serviceClass: ${beforeWithClass})`);
    console.warn(`rows after:                  ${after} (with serviceClass: ${afterWithClass})`);
    console.warn('NOTE: only the lookup table was touched. No Vehicle / VehicleClassification writes.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
