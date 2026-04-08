import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.warn('Seeding BSOP database...');

  // --- Site ---
  const site = await prisma.site.upsert({
    where: { code: 'BERT-01' },
    update: {},
    create: {
      code: 'BERT-01',
      name: "Bert's Auto Parts Service Centre — Main",
      timezone: 'America/Jamaica',
    },
  });
  console.warn(`Site: ${site.code} (${site.id})`);

  // --- Users ---
  const BCRYPT_ROUNDS = 12;
  const users = [
    { email: 'admin@bert.local', fullName: 'Admin User', roleCode: 'ADMIN', password: 'admin123' },
    { email: 'manager@bert.local', fullName: 'Manager User', roleCode: 'MANAGER', password: 'manager123' },
    { email: 'frontdesk@bert.local', fullName: 'Front Desk User', roleCode: 'FRONT_DESK', password: 'frontdesk123' },
    { email: 'advisor@bert.local', fullName: 'Service Advisor', roleCode: 'SERVICE_ADVISOR', password: 'advisor123' },
    { email: 'tech1@bert.local', fullName: 'Technician One', roleCode: 'TECHNICIAN', password: 'tech123' },
    { email: 'tech2@bert.local', fullName: 'Technician Two', roleCode: 'TECHNICIAN', password: 'tech123' },
    { email: 'tech3@bert.local', fullName: 'Technician Three', roleCode: 'TECHNICIAN', password: 'tech123' },
    { email: 'tech4@bert.local', fullName: 'Technician Four', roleCode: 'TECHNICIAN', password: 'tech123' },
    { email: 'tech5@bert.local', fullName: 'Technician Five', roleCode: 'TECHNICIAN', password: 'tech123' },
    { email: 'parts@bert.local', fullName: 'Parts Staff', roleCode: 'PARTS_STAFF', password: 'parts123' },
  ];

  const createdUsers: Record<string, string> = {};
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
    const user = await prisma.userAccount.upsert({
      where: { authSubject: u.email },
      update: {},
      create: {
        email: u.email,
        fullName: u.fullName,
        roleCode: u.roleCode,
        passwordHash: hash,
        authSubject: u.email,
        siteId: site.id,
      },
    });
    createdUsers[u.email] = user.id;
  }
  console.warn(`Users: ${Object.keys(createdUsers).length} seeded`);

  // --- Service Types (from data/service_catalogue.csv) ---
  const serviceTypes = [
    { code: 'OIL-01', name: 'Oil Change', family: 'Quick Service', baseDurationMinutes: 30, quickService: true, requiredSkillCode: 'LUBE', requiredBayType: 'LUBE', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK' },
    { code: 'TIR-01', name: 'Tire Rotation', family: 'Quick Service', baseDurationMinutes: 25, quickService: true, requiredSkillCode: 'TIRE', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'QUICK' },
    { code: 'BAT-01', name: 'Battery Test / Replace', family: 'Electrical / Quick', baseDurationMinutes: 30, quickService: true, requiredSkillCode: 'ELECTRICAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK' },
    { code: 'BRK-01', name: 'Brake Inspection', family: 'Brakes', baseDurationMinutes: 30, quickService: false, requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'BRAKES' },
    { code: 'BRK-02', name: 'Brake Pad Replacement', family: 'Brakes', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: 'BRAKES' },
    { code: 'TIR-02', name: 'Wheel Alignment', family: 'Tires', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'ALIGNMENT', requiredBayType: 'ALIGNMENT', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null },
    { code: 'TIR-03', name: 'Tire Install & Balance', family: 'Tires', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'TIRE', requiredBayType: 'TIRE', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null },
    { code: 'AC-01', name: 'A/C Diagnostic', family: 'A/C', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'AC', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null },
    { code: 'AC-02', name: 'A/C Repair', family: 'A/C', baseDurationMinutes: 180, quickService: false, requiredSkillCode: 'AC', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null },
    { code: 'ENG-01', name: 'Engine Diagnostic', family: 'Diagnostics', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'DIAG', requiredBayType: 'DIAGNOSTIC', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'DIAG' },
    { code: 'ENG-02', name: 'Major Tune-Up', family: 'Engine', baseDurationMinutes: 180, quickService: false, requiredSkillCode: 'ENGINE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null },
    { code: 'ELE-01', name: 'Electrical Diagnostic', family: 'Electrical', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'ELECTRICAL', requiredBayType: 'DIAGNOSTIC', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'DIAG' },
    { code: 'COL-01', name: 'Cooling System Service', family: 'Cooling', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null },
    { code: 'SUSP-01', name: 'Suspension Inspection', family: 'Suspension', baseDurationMinutes: 45, quickService: false, requiredSkillCode: 'SUSPENSION', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null },
    { code: 'SUSP-02', name: 'Shock / Strut Replacement', family: 'Suspension', baseDurationMinutes: 180, quickService: false, requiredSkillCode: 'SUSPENSION', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null },
    { code: 'TRANS-01', name: 'Transmission Diagnostic', family: 'Transmission', baseDurationMinutes: 120, quickService: false, requiredSkillCode: 'TRANSMISSION', requiredBayType: 'DIAGNOSTIC', partsPrepositionRequired: false, transportEligible: true, batchingFamily: null },
    { code: 'INSP-01', name: 'Pre-Purchase Inspection', family: 'Inspection', baseDurationMinutes: 75, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'INSPECTION', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null },
    { code: 'GEN-01', name: 'General Diagnostic', family: 'Diagnostics', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'DIAGNOSTIC', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'DIAG' },
    { code: 'BEL-01', name: 'Belt / Hose Replacement', family: 'Engine / Cooling', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null },
    { code: 'SPK-01', name: 'Spark Plug Replacement', family: 'Engine', baseDurationMinutes: 120, quickService: false, requiredSkillCode: 'ENGINE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null },
  ];

  for (const st of serviceTypes) {
    await prisma.serviceType.upsert({
      where: { code: st.code },
      update: {},
      create: st,
    });
  }
  console.warn(`Service types: ${serviceTypes.length} seeded`);

  // --- Business Rule Configs ---
  const rules: Array<{ ruleKey: string; valueJson: unknown; notes: string }> = [
    { ruleKey: 'protected_window_early_min', valueJson: 30, notes: 'Minutes before appointment that protection starts' },
    { ruleKey: 'protected_window_late_min', valueJson: 15, notes: 'Minutes after appointment that protection ends' },
    { ruleKey: 'missed_threshold_min', valueJson: 30, notes: 'Minutes late before MISSED classification' },
    { ruleKey: 'lateness_penalty_per_min', valueJson: 3, notes: 'Score penalty per minute late' },
    { ruleKey: 'wait_time_bonus_per_min', valueJson: 2, notes: 'Score bonus per minute waiting' },
    { ruleKey: 'wait_time_bonus_cap_min', valueJson: 120, notes: 'Maximum minutes for wait bonus' },
    { ruleKey: 'fairness_threshold_min', valueJson: 90, notes: 'Walk-in wait time before escalation alert' },
    { ruleKey: 'quick_service_bonus', valueJson: 50, notes: 'Score bonus for quick-service (disabled Phase 1)' },
    { ruleKey: 'batching_bonus', valueJson: 30, notes: 'Score bonus for batching (disabled Phase 1)' },
    { ruleKey: 'max_protected_delay_min', valueJson: 10, notes: 'Max delay to protected appt from fast-track insertion' },
    { ruleKey: 'base_weight_APPT_PROTECTED', valueJson: 1000, notes: 'Scoring base weight' },
    { ruleKey: 'base_weight_APPT_LATE_SOFT', valueJson: 800, notes: 'Scoring base weight' },
    { ruleKey: 'base_weight_WALKIN_STANDARD', valueJson: 600, notes: 'Scoring base weight' },
    { ruleKey: 'base_weight_WALKIN_FASTTRACK', valueJson: 650, notes: 'Scoring base weight' },
    { ruleKey: 'default_oil_interval_miles', valueJson: 5000, notes: 'Fallback oil change interval in miles' },
    { ruleKey: 'default_oil_interval_months', valueJson: 6, notes: 'Fallback oil change interval in months' },
    {
      ruleKey: 'operating_hours',
      valueJson: {
        schedule: {
          '1': { open: '08:00', close: '17:00' }, // Monday
          '2': { open: '08:00', close: '17:00' }, // Tuesday
          '3': { open: '08:00', close: '17:00' }, // Wednesday
          '4': { open: '08:00', close: '17:00' }, // Thursday
          '5': { open: '08:00', close: '17:00' }, // Friday
          '6': { open: '08:00', close: '13:00' }, // Saturday
          // 0 = Sunday: absent = closed
        },
      },
      notes: 'Per-day operating schedule (site-local time). Keys are JS getDay(): 0=Sun, 1=Mon...6=Sat',
    },
  ];

  for (const r of rules) {
    const existing = await prisma.businessRuleConfig.findFirst({
      where: { ruleKey: r.ruleKey, siteId: site.id },
    });
    if (!existing) {
      await prisma.businessRuleConfig.create({
        data: {
          ruleKey: r.ruleKey,
          valueJson: r.valueJson as any,
          notes: r.notes,
          siteId: site.id,
          createdByUserId: createdUsers['admin@bert.local'],
        },
      });
    }
  }
  console.warn(`Business rules: ${rules.length} seeded`);

  // --- Technicians ---
  const techSpecs = [
    { email: 'tech1@bert.local', employeeCode: 'TECH-001', skills: [{ code: 'GENERAL', level: 3 }, { code: 'LUBE', level: 3 }, { code: 'BRAKE', level: 2 }, { code: 'TIRE', level: 2 }] },
    { email: 'tech2@bert.local', employeeCode: 'TECH-002', skills: [{ code: 'GENERAL', level: 3 }, { code: 'ELECTRICAL', level: 3 }, { code: 'ENGINE', level: 2 }, { code: 'DIAG', level: 2 }] },
    { email: 'tech3@bert.local', employeeCode: 'TECH-003', skills: [{ code: 'GENERAL', level: 2 }, { code: 'AC', level: 3 }, { code: 'COOLING', level: 2 }] },
    { email: 'tech4@bert.local', employeeCode: 'TECH-004', skills: [{ code: 'GENERAL', level: 3 }, { code: 'SUSPENSION', level: 3 }, { code: 'ALIGNMENT', level: 3 }] },
    { email: 'tech5@bert.local', employeeCode: 'TECH-005', skills: [{ code: 'GENERAL', level: 1 }, { code: 'LUBE', level: 2 }] },
  ];

  for (const t of techSpecs) {
    const userId = createdUsers[t.email];
    if (!userId) continue;

    const existing = await prisma.technician.findUnique({ where: { userAccountId: userId } });
    if (!existing) {
      const tech = await prisma.technician.create({
        data: {
          userAccountId: userId,
          employeeCode: t.employeeCode,
          homeSiteId: site.id,
        },
      });

      for (const skill of t.skills) {
        await prisma.technicianSkill.create({
          data: {
            technicianId: tech.id,
            skillCode: skill.code,
            proficiencyLevel: skill.level,
            isPrimary: skill === t.skills[0],
          },
        });
      }
    }
  }
  console.warn(`Technicians: ${techSpecs.length} seeded with skills`);

  // --- Work Bays ---
  const bays = [
    { code: 'BAY-01', bayType: 'GENERAL' },
    { code: 'BAY-02', bayType: 'GENERAL' },
    { code: 'BAY-03', bayType: 'LUBE' },
    { code: 'BAY-04', bayType: 'ALIGNMENT' },
    { code: 'BAY-05', bayType: 'DIAGNOSTIC' },
    { code: 'BAY-06', bayType: 'INSPECTION' },
  ];

  for (const b of bays) {
    const existing = await prisma.workBay.findUnique({
      where: { siteId_code: { siteId: site.id, code: b.code } },
    });
    if (!existing) {
      await prisma.workBay.create({
        data: { siteId: site.id, code: b.code, bayType: b.bayType },
      });
    }
  }
  console.warn(`Work bays: ${bays.length} seeded`);

  // --- v4.1: Work Resources (alongside WorkBay, migration-safe) ---
  const resources = [
    { code: 'BAY-01', name: 'Heavy Lift 1', resourceCategory: 'BAY' as const, maxVehicleWeight: 'HEAVY' as const, liftType: 'heavy', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 1, capabilities: { isIndoor: true } },
    { code: 'BAY-02', name: 'Heavy Lift 2', resourceCategory: 'BAY' as const, maxVehicleWeight: 'HEAVY' as const, liftType: 'heavy', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 2, capabilities: { isIndoor: true } },
    { code: 'BAY-03', name: 'Sedan Lift', resourceCategory: 'BAY' as const, maxVehicleWeight: 'STANDARD' as const, liftType: 'sedan', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 3, capabilities: { isIndoor: true } },
    { code: 'BAY-04', name: 'Mobile Lift', resourceCategory: 'BAY' as const, maxVehicleWeight: 'STANDARD' as const, liftType: 'mobile', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 4, capabilities: { isIndoor: true } },
    { code: 'BAY-05', name: 'Power Jack', resourceCategory: 'BAY' as const, maxVehicleWeight: 'LIGHT' as const, liftType: 'power_jack', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 5, capabilities: { isIndoor: true } },
    { code: 'BAY-06', name: 'Bay 6 (TBD)', resourceCategory: 'BAY' as const, maxVehicleWeight: 'STANDARD' as const, liftType: null, hasAlignment: true, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 6, capabilities: { isIndoor: true }, notes: 'Pending: confirm alignment or other capability' },
    { code: 'BAY-07', name: 'Bay 7 (TBD)', resourceCategory: 'BAY' as const, maxVehicleWeight: 'STANDARD' as const, liftType: null, hasAlignment: false, hasDiagnostics: true, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 7, capabilities: { isIndoor: true }, notes: 'Pending: confirm diagnostics or other capability' },
    { code: 'OVF-01', name: 'Overflow Slot A', resourceCategory: 'OVERFLOW' as const, maxVehicleWeight: 'STANDARD' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 10, capabilities: { isGroundLevel: true } },
    { code: 'OVF-02', name: 'Overflow Slot B', resourceCategory: 'OVERFLOW' as const, maxVehicleWeight: 'STANDARD' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, displayOrder: 11, capabilities: { isGroundLevel: true } },
    { code: 'LT-01', name: 'Light Task Slot 1', resourceCategory: 'LIGHT_SLOT' as const, maxVehicleWeight: 'LIGHT' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: false, showOnDispatchBoard: true, displayOrder: 20, capabilities: { wiperChange: true, carWash: true, quickCheck: true } },
    { code: 'LT-02', name: 'Light Task Slot 2', resourceCategory: 'LIGHT_SLOT' as const, maxVehicleWeight: 'LIGHT' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: false, showOnDispatchBoard: true, displayOrder: 21, capabilities: { wiperChange: true, carWash: true, quickCheck: true } },
  ];

  for (const r of resources) {
    const existing = await prisma.workResource.findUnique({
      where: { siteId_code: { siteId: site.id, code: r.code } },
    });
    if (!existing) {
      await prisma.workResource.create({
        data: { siteId: site.id, ...r },
      });
    }
  }
  console.warn(`Work resources: ${resources.length} seeded`);

  // --- v4.1: Initialize ResourceOccupancy for each resource (all AVAILABLE) ---
  const allResources = await prisma.workResource.findMany({ where: { siteId: site.id } });
  for (const res of allResources) {
    const existing = await prisma.resourceOccupancy.findUnique({ where: { resourceId: res.id } });
    if (!existing) {
      await prisma.resourceOccupancy.create({
        data: { resourceId: res.id, status: 'AVAILABLE' },
      });
    }
  }
  console.warn(`Resource occupancies: ${allResources.length} initialized`);

  // --- v4.1: Additional Business Rule Configs ---
  const v41Rules: Array<{ ruleKey: string; valueJson: unknown; notes: string }> = [
    { ruleKey: 'reservation_activation_min', valueJson: 30, notes: 'Minutes before appointment that bay reservation activates' },
    { ruleKey: 'reservation_expiry_min', valueJson: 45, notes: 'Minutes after scheduled start before reservation expires' },
    { ruleKey: 'eta_band_narrow_min', valueJson: 15, notes: 'Narrow ETA band width in minutes (positions 1-2)' },
    { ruleKey: 'eta_band_wide_min', valueJson: 30, notes: 'Wide ETA band width in minutes (positions 3+)' },
    { ruleKey: 'reminder_lead_days', valueJson: 14, notes: 'Days before due date to send maintenance reminder' },
    { ruleKey: 'reminder_mileage_threshold', valueJson: 500, notes: 'Miles before due mileage to send maintenance reminder' },
    { ruleKey: 'oil_brand_options', valueJson: ['Amsoil', 'Liqui Moly', 'Valvoline', 'Castrol', 'Mobil 1', 'Other'], notes: 'Oil brand dropdown options for intake' },
    { ruleKey: 'oil_grade_presets', valueJson: ['0W-20', '5W-20', '5W-30', '10W-30', '10W-40', '15W-40', '0W-40'], notes: 'Oil grade preset options for intake' },
    { ruleKey: 'blocked_return_policy', valueJson: 'ORIGINAL_POSITION', notes: 'Where unblocked tickets return: ORIGINAL_POSITION or END_OF_LINE' },
    { ruleKey: 'completion_requires_front_desk_action', valueJson: true, notes: 'Whether tech completion requires front desk to notify customer' },
    { ruleKey: 'notification_provider_sms', valueJson: 'stub', notes: 'SMS provider: stub | twilio' },
    { ruleKey: 'notification_provider_email', valueJson: 'stub', notes: 'Email provider: stub | sendgrid | smtp' },
    { ruleKey: 'overflow_mechanic_required', valueJson: true, notes: 'Whether overflow slots require a mechanic assignment' },
    { ruleKey: 'light_slot_mechanic_required', valueJson: false, notes: 'Whether light task slots require a mechanic assignment' },
  ];

  for (const r of v41Rules) {
    const existing = await prisma.businessRuleConfig.findFirst({
      where: { ruleKey: r.ruleKey, siteId: site.id },
    });
    if (!existing) {
      await prisma.businessRuleConfig.create({
        data: {
          ruleKey: r.ruleKey,
          valueJson: r.valueJson as any,
          notes: r.notes,
          siteId: site.id,
          createdByUserId: createdUsers['admin@bert.local'],
        },
      });
    }
  }
  console.warn(`v4.1 business rules: ${v41Rules.length} seeded`);

  // --- v4.1: Vehicle weight suggestions (common makes) ---
  const weightSuggestions = [
    { makePattern: 'Toyota', modelPattern: 'Hilux', suggestedWeightClass: 'STANDARD' as const },
    { makePattern: 'Toyota', modelPattern: 'Land Cruiser', suggestedWeightClass: 'HEAVY' as const },
    { makePattern: 'Toyota', modelPattern: 'Corolla', suggestedWeightClass: 'LIGHT' as const },
    { makePattern: 'Toyota', modelPattern: 'Camry', suggestedWeightClass: 'LIGHT' as const },
    { makePattern: 'Honda', modelPattern: 'Civic', suggestedWeightClass: 'LIGHT' as const },
    { makePattern: 'Honda', modelPattern: 'CR-V', suggestedWeightClass: 'STANDARD' as const },
    { makePattern: 'Nissan', modelPattern: 'Patrol', suggestedWeightClass: 'HEAVY' as const },
    { makePattern: 'Ford', modelPattern: 'F-150', suggestedWeightClass: 'HEAVY' as const },
    { makePattern: 'Ford', modelPattern: 'Ranger', suggestedWeightClass: 'STANDARD' as const },
    { makePattern: 'Suzuki', modelPattern: 'Swift', suggestedWeightClass: 'LIGHT' as const },
    { makePattern: 'Hyundai', modelPattern: 'Tucson', suggestedWeightClass: 'STANDARD' as const },
  ];

  for (const ws of weightSuggestions) {
    await prisma.vehicleWeightSuggestion.create({ data: ws });
  }
  console.warn(`Vehicle weight suggestions: ${weightSuggestions.length} seeded`);

  console.warn('Seed complete.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
