import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { seedInspectionTemplate } from './inspection-template-data';
import { seedKpiFramework } from './kpi-seed-data';

const prisma = new PrismaClient();

async function main() {
  console.warn('Seeding BSOP database...');

  // --- Site ---
  const site = await prisma.site.upsert({
    where: { code: 'BERT-01' },
    update: { ticketCode: 'B01' },
    create: {
      code: 'BERT-01',
      name: "Bert's Auto Parts Service Centre — Main",
      timezone: 'America/Jamaica',
      // CR-2026-089 — short code used in queue ticket references, e.g. B01-260820-003.
      ticketCode: 'B01',
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
    { email: 'parts@bert.local', fullName: 'Parts Staff', roleCode: 'PARTS_STAFF', password: 'parts123' },
  ];

  // --- Real technician roster (extracted from SharePoint "Service Center Job Sheet"
  //     export, Oct 2023 – Jun 2026, by job-assignment frequency). Each technician
  //     needs a UserAccount (display name + login). Shared dev password 'tech123';
  //     the first entry (O. Josephs) is the documented technician demo login.
  //     NOTE (assumption): the export does NOT contain per-technician skill data, so
  //     every technician is seeded with a baseline GENERAL+LUBE skill only. Real skill
  //     matrices must be collected from operations — see the SharePoint re-export /
  //     data-collection request before relying on skill-based scheduling. ---
  const technicianRoster = [
    { email: 'o.josephs@bert.local', fullName: 'O. Josephs', employeeCode: 'BERT-T01' },
    { email: 'm.walker@bert.local', fullName: 'M. Walker', employeeCode: 'BERT-T02' },
    { email: 'o.hamilton@bert.local', fullName: 'O. Hamilton', employeeCode: 'BERT-T03' },
    { email: 'k.thomas@bert.local', fullName: 'K. Thomas', employeeCode: 'BERT-T04' },
    { email: 'd.willis@bert.local', fullName: 'D. Willis', employeeCode: 'BERT-T05' },
    { email: 'j.walters@bert.local', fullName: 'J. Walters', employeeCode: 'BERT-T06' },
    { email: 'd.dennis@bert.local', fullName: 'D. Dennis', employeeCode: 'BERT-T07' },
    { email: 'd.hibbert@bert.local', fullName: 'D. Hibbert', employeeCode: 'BERT-T08' },
    { email: 'w.taylor@bert.local', fullName: 'W. Taylor', employeeCode: 'BERT-T09' },
    { email: 'c.johnson@bert.local', fullName: 'C. Johnson', employeeCode: 'BERT-T10' },
    { email: 't.lewis@bert.local', fullName: 'T. Lewis', employeeCode: 'BERT-T11' },
    { email: 'r.walker@bert.local', fullName: 'R. Walker', employeeCode: 'BERT-T12' },
  ];
  // CR-2026-095 — the technician roster is FIRST-INSTALL data, not a standing
  // truth. Once the shop manages its own staff in the application, a deploy must
  // not resurrect a technician an administrator deliberately deleted — so roster
  // accounts are only created while the technician table is still empty. Core
  // system logins above are exempt: they are infrastructure, not staff decisions.
  const isFirstInstall = (await prisma.technician.count()) === 0;
  if (isFirstInstall) {
    for (const t of technicianRoster) {
      users.push({ email: t.email, fullName: t.fullName, roleCode: 'TECHNICIAN', password: 'tech123' });
    }
  }

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
    // --- DMAIC-confirmed services with operational flags ---
    { code: 'OIL-01', name: 'Oil Change', family: 'Service', baseDurationMinutes: 30, quickService: true, requiredSkillCode: 'LUBE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK', requiresMileage: true, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'OIL-FLT-01', name: 'Oil Filter Change', family: 'Service', baseDurationMinutes: 20, quickService: true, requiredSkillCode: 'LUBE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK', requiresMileage: true, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'AIR-FLT-01', name: 'Air Filter Change', family: 'Service', baseDurationMinutes: 15, quickService: true, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'FUEL-FLT-01', name: 'Fuel Filter Change', family: 'Service', baseDurationMinutes: 30, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'BAT-01', name: 'Battery Change', family: 'Service', baseDurationMinutes: 45, quickService: false, requiredSkillCode: 'ELECTRICAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'SHOCK-01', name: 'Shocks Replacement', family: 'Service', baseDurationMinutes: 120, quickService: false, requiredSkillCode: 'SUSPENSION', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'BULB-01', name: 'Bulb Replacement', family: 'Quick Service', baseDurationMinutes: 15, quickService: true, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'BJOINT-01', name: 'Ball Joint Replacement', family: 'Service', baseDurationMinutes: 120, quickService: false, requiredSkillCode: 'SUSPENSION', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'BELT-01', name: 'Belt Replacement', family: 'Service', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'RACK-01', name: 'Rack & Pinion', family: 'Service', baseDurationMinutes: 180, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'DISC-01', name: 'Disc Pad Change', family: 'Service', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'BRAKES', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'WIPER-01', name: 'Wiper Blade Change', family: 'Quick Service', baseDurationMinutes: 10, quickService: true, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: 'QUICK', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'CLEAN-01', name: 'Vehicle Cleaning', family: 'Cleaning', baseDurationMinutes: 30, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: true, standPreferred: false, mobileJackAllowed: false },
    { code: 'MSHOP-01', name: 'Machine Shop Work', family: 'External', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: true, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: false },
    { code: 'EST-01', name: 'Estimate / Inspection', family: 'Service', baseDurationMinutes: 30, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    // --- Existing services retained with DMAIC flags ---
    { code: 'TIR-01', name: 'Tire Rotation', family: 'Quick Service', baseDurationMinutes: 25, quickService: true, requiredSkillCode: 'TIRE', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'QUICK', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'BRK-01', name: 'Brake Inspection', family: 'Brakes', baseDurationMinutes: 30, quickService: false, requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'BRAKES', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'BRK-02', name: 'Brake Pad Replacement', family: 'Brakes', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: 'BRAKES', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'TIR-02', name: 'Wheel Alignment', family: 'Tires', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'ALIGNMENT', requiredBayType: 'ALIGNMENT', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'TIR-03', name: 'Tire Install & Balance', family: 'Tires', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'TIRE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    // A/C services discontinued (CR-2026-042) — not offered. Removed from seed so
    // fresh databases never list them. To restore: re-add AC-01 / AC-02 here (and
    // their rows in data/service_catalogue.csv) and reseed.
    { code: 'ENG-01', name: 'Engine Diagnostic', family: 'Diagnostics', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'DIAG', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'DIAG', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'ENG-02', name: 'Major Tune-Up', family: 'Engine', baseDurationMinutes: 180, quickService: false, requiredSkillCode: 'ENGINE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'ELE-01', name: 'Electrical Diagnostic', family: 'Electrical', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'ELECTRICAL', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'DIAG', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'COL-01', name: 'Cooling System Service', family: 'Cooling', baseDurationMinutes: 90, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'SUSP-01', name: 'Suspension Inspection', family: 'Suspension', baseDurationMinutes: 45, quickService: false, requiredSkillCode: 'SUSPENSION', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'SUSP-02', name: 'Shock / Strut Replacement', family: 'Suspension', baseDurationMinutes: 180, quickService: false, requiredSkillCode: 'SUSPENSION', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'TRANS-01', name: 'Transmission Diagnostic', family: 'Transmission', baseDurationMinutes: 120, quickService: false, requiredSkillCode: 'TRANSMISSION', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: true, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'INSP-01', name: 'Pre-Purchase Inspection', family: 'Inspection', baseDurationMinutes: 75, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: false, mobileJackAllowed: true },
    { code: 'GEN-01', name: 'General Diagnostic', family: 'Diagnostics', baseDurationMinutes: 60, quickService: false, requiredSkillCode: 'GENERAL', requiredBayType: 'GENERAL', partsPrepositionRequired: false, transportEligible: false, batchingFamily: 'DIAG', requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
    { code: 'SPK-01', name: 'Spark Plug Replacement', family: 'Engine', baseDurationMinutes: 120, quickService: false, requiredSkillCode: 'ENGINE', requiredBayType: 'GENERAL', partsPrepositionRequired: true, transportEligible: false, batchingFamily: null, requiresMileage: false, isExternal: false, requiresPowerWash: false, standPreferred: true, mobileJackAllowed: false },
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
  // CR-2026-067 — every technician can do everything: seed the FULL skill set on each
  // technician so no service is ever unassignable for lack of a skill. Managers can
  // still tune per-technician skills in Staff management (add/remove). This supersedes
  // the CR-2026-061 demo spread. Skill codes mirror every service's requiredSkillCode.
  const ALL_SKILL_CODES = [
    'GENERAL', 'LUBE', 'ELECTRICAL', 'BRAKE', 'SUSPENSION',
    'TIRE', 'ALIGNMENT', 'DIAG', 'ENGINE', 'TRANSMISSION',
  ];
  const techSpecs = technicianRoster.map((t) => ({
    email: t.email,
    employeeCode: t.employeeCode,
    skills: ALL_SKILL_CODES.map((code) => ({
      code,
      level: code === 'GENERAL' || code === 'LUBE' ? 2 : 3,
    })),
  }));

  for (const t of techSpecs) {
    // On a first install the account was just created above; on later runs the
    // roster accounts were not touched, so resolve whoever still exists. A deleted
    // technician resolves to nothing and is NOT recreated — that deletion was a
    // management decision this seed has no business reversing. Existing technicians
    // still get the additive skill top-up (CR-2026-067).
    const userId =
      createdUsers[t.email] ??
      (await prisma.userAccount.findUnique({ where: { authSubject: t.email }, select: { id: true } }))?.id;
    if (!userId) continue;

    // Idempotent + additive: upsert the technician, then add any missing skills so a
    // re-run applies the specialized spread to already-seeded technicians.
    const tech = await prisma.technician.upsert({
      where: { userAccountId: userId },
      update: {},
      create: {
        userAccountId: userId,
        employeeCode: t.employeeCode,
        homeSiteId: site.id,
      },
    });

    for (const skill of t.skills) {
      const existingSkill = await prisma.technicianSkill.findFirst({
        where: { technicianId: tech.id, skillCode: skill.code },
      });
      if (!existingSkill) {
        await prisma.technicianSkill.create({
          data: {
            technicianId: tech.id,
            skillCode: skill.code,
            proficiencyLevel: skill.level,
            isPrimary: skill.code === 'GENERAL',
          },
        });
      }
    }
  }
  console.warn(`Technicians: ${techSpecs.length} seeded with full skill set (${ALL_SKILL_CODES.length} skills each)`);

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

  // --- DMAIC-confirmed Work Resources ---
  const resources = [
    // Active: confirmed equipment from DMAIC
    { code: 'STAND-01', name: 'Stand 1', resourceCategory: 'BAY' as const, maxVehicleWeight: 'HEAVY' as const, liftType: 'heavy', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, isActive: true, displayOrder: 1, capabilities: { isIndoor: true } },
    { code: 'STAND-02', name: 'Stand 2', resourceCategory: 'BAY' as const, maxVehicleWeight: 'HEAVY' as const, liftType: 'heavy', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, isActive: true, displayOrder: 2, capabilities: { isIndoor: true } },
    { code: 'MJACK-01', name: 'Mobile Jack 1', resourceCategory: 'BAY' as const, maxVehicleWeight: 'STANDARD' as const, liftType: 'mobile', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, isActive: true, displayOrder: 3, capabilities: { sedanOnly: true }, notes: 'Sedan-only: LIGHT + STANDARD vehicles. No HEAVY.' },
    { code: 'MJACK-02', name: 'Mobile Jack 2', resourceCategory: 'BAY' as const, maxVehicleWeight: 'STANDARD' as const, liftType: 'mobile', hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: true, isActive: true, displayOrder: 4, capabilities: { sedanOnly: true }, notes: 'Sedan-only: LIGHT + STANDARD vehicles. No HEAVY.' },
    { code: 'PWASH-01', name: 'Power Wash', resourceCategory: 'POWER_WASH' as const, maxVehicleWeight: 'HEAVY' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: false, showOnDispatchBoard: true, isActive: true, displayOrder: 5, capabilities: { cleaning: true }, notes: 'Cleaning only. Requires operational status check before dispatch.' },
    { code: 'MSHOP-EXT', name: 'External Machine Shop', resourceCategory: 'EXTERNAL' as const, maxVehicleWeight: 'HEAVY' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: false, showOnDispatchBoard: true, isActive: true, displayOrder: 6, capabilities: {}, notes: 'External facility. Jobs logged but not bay-scheduled.' },
    // Inactive: placeholders until confirmed by operations
    { code: 'OVF-01', name: 'Overflow Slot A', resourceCategory: 'OVERFLOW' as const, maxVehicleWeight: 'STANDARD' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: false, isActive: false, displayOrder: 10, capabilities: { isGroundLevel: true }, notes: 'Placeholder — not confirmed as live capacity' },
    { code: 'OVF-02', name: 'Overflow Slot B', resourceCategory: 'OVERFLOW' as const, maxVehicleWeight: 'STANDARD' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: true, showOnDispatchBoard: false, isActive: false, displayOrder: 11, capabilities: { isGroundLevel: true }, notes: 'Placeholder — not confirmed as live capacity' },
    { code: 'LT-01', name: 'Light Task Slot 1', resourceCategory: 'LIGHT_SLOT' as const, maxVehicleWeight: 'LIGHT' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: false, showOnDispatchBoard: false, isActive: false, displayOrder: 20, capabilities: {}, notes: 'Placeholder — not confirmed as live capacity' },
    { code: 'LT-02', name: 'Light Task Slot 2', resourceCategory: 'LIGHT_SLOT' as const, maxVehicleWeight: 'LIGHT' as const, liftType: null, hasAlignment: false, hasDiagnostics: false, requiresMechanic: false, showOnDispatchBoard: false, isActive: false, displayOrder: 21, capabilities: {}, notes: 'Placeholder — not confirmed as live capacity' },
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
    { ruleKey: 'oil_brand_options', valueJson: ['Regular Oil', 'Liqui Moly', 'Amsoil', 'Other'], notes: 'Oil brand/type dropdown options for intake. Aligned to the values actually used in the SharePoint job sheet (Regular Oil, Liqui Moly, Amsoil); "Not Servicing" is represented by leaving oil empty / non-service job, not a brand option.' },
    { ruleKey: 'oil_grade_presets', valueJson: ['0W-20', '5W-20', '5W-30', '10W-30', '10W-40', '15W-40', '0W-40'], notes: 'Oil grade preset options for intake' },
    { ruleKey: 'blocked_return_policy', valueJson: 'ORIGINAL_POSITION', notes: 'Where unblocked tickets return: ORIGINAL_POSITION or END_OF_LINE' },
    { ruleKey: 'completion_requires_front_desk_action', valueJson: true, notes: 'Whether tech completion requires front desk to notify customer' },
    { ruleKey: 'display_board_enabled', valueJson: true, notes: 'Whether the public waiting-room display board (/display/:token) is active' },
    { ruleKey: 'display_board_token', valueJson: 'bert-display-7f3a9c2e4b81d6', notes: 'Unguessable token gating the public waiting-room display board URL (/display/:token). No login is required on the screen; rotate this value if the URL leaks.' },
    { ruleKey: 'notification_provider_sms', valueJson: 'stub', notes: 'SMS provider: stub | twilio' },
    { ruleKey: 'notification_provider_email', valueJson: 'stub', notes: 'Email provider: stub | sendgrid | smtp' },
    { ruleKey: 'appointment_reminder_enabled', valueJson: true, notes: 'CR-2026-056: whether the automatic appointment reminder (sent ~24h before) is active' },
    { ruleKey: 'appointment_reminder_hours', valueJson: 24, notes: 'CR-2026-056: how many hours before scheduledStartAt the reminder fires (hourly cron sweep)' },
    // CR-2026-086 — "tell the customer their next service is due". Everything for this
    // was already built (auto-created reminders, send-date maths, opt-in, quiet hours,
    // SMS/email dispatch) except anything that CALLED it, so reminders sat in SCHEDULED
    // forever. An hourly cron now sweeps them. DEFAULT OFF on purpose: switching it on
    // messages every opted-in customer holding a scheduled reminder, so that should be
    // a decision someone takes having looked at the backlog, not a deploy side effect.
    { ruleKey: 'maintenance_reminder_enabled', valueJson: false, notes: 'CR-2026-086: master switch for the hourly due-for-service reminder sweep. OFF by default — check the SCHEDULED reminder backlog before enabling, as they all send on the next sweep.' },
    // CR-2026-086 — technician KPI benchmark, supplied by the service manager.
    // Bands are inclusive upper bounds in hours, fastest first; the final band has
    // maxHours: null and catches everything above.
    {
      ruleKey: 'kpi_rating_bands',
      valueJson: [
        { maxHours: 2.0, rating: 'EXCELLENT' },
        { maxHours: 2.5, rating: 'MEETS_TARGET' },
        { maxHours: 3.0, rating: 'NEEDS_IMPROVEMENT' },
        { maxHours: null, rating: 'BELOW_STANDARD' },
      ],
      notes: 'CR-2026-086: technician performance rating by completion time. <=2.0h Excellent, 2.01-2.5h Meets Target, 2.51-3.0h Needs Improvement, >3.0h Below Standard.',
    },
    {
      ruleKey: 'kpi_package_standard_hours',
      valueJson: {
        GENERAL_SERVICE: 1.5,
        GENERAL_SERVICE_FRONT_BRAKES: 2.0,
        GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 2.5,
      },
      notes: 'CR-2026-086: standard time in hours for each service package benchmark.',
    },
    // CR-2026-061 — config keys the code reads with a hardcoded fallback; seed them (= the code defaults) so they are visible/tunable.
    { ruleKey: 'eta_avg_live_window_days', valueJson: 30, notes: 'CR-2026-061: days of live history used for the ETA average window (queue.service ETA calc)' },
    { ruleKey: 'eta_avg_min_live_sample', valueJson: 20, notes: 'CR-2026-061: minimum live service-order sample before using the live average vs historical' },
    { ruleKey: 'eta_avg_outlier_cap_minutes', valueJson: 0, notes: 'CR-2026-061: cap on per-service duration outliers in the ETA average (0 = no cap)' },
    { ruleKey: 'classification_daily_target', valueJson: 50, notes: 'CR-2026-061: daily target vehicle count for the classification review queue' },
    { ruleKey: 'complaint_sla_hours_by_severity', valueJson: { LOW: 120, MEDIUM: 72, HIGH: 24, CRITICAL: 4 }, notes: 'CR-2026-061: complaint SLA hours per severity (LOW/MEDIUM/HIGH/CRITICAL)' },
    { ruleKey: 'overflow_mechanic_required', valueJson: true, notes: 'Whether overflow slots require a mechanic assignment' },
    { ruleKey: 'light_slot_mechanic_required', valueJson: false, notes: 'Whether light task slots require a mechanic assignment' },
    { ruleKey: 'reminder_eligible_service_types', valueJson: ['OIL-01'], notes: 'Service type codes eligible for automated maintenance reminders' },
    // DMAIC alignment rules
    { ruleKey: 'same_day_appointment_cutoff_time', valueJson: '10:00', notes: 'Time after which same-day appointments require manager override (HH:mm site-local)' },
    { ruleKey: 'same_day_walkin_policy', valueJson: 'ALLOW', notes: 'Walk-in policy after cutoff: ALLOW | REQUIRE_OVERRIDE | BLOCK' },
    { ruleKey: 'manager_override_required_after_cutoff', valueJson: true, notes: 'Whether same-day cutoff is enforced (true) or advisory (false)' },
    { ruleKey: 'midday_followup_enabled', valueJson: true, notes: 'DMAIC Rule 2: send a same-day follow-up for jobs COMPLETED before noon' },
    { ruleKey: 'midday_followup_run_time', valueJson: '12:15', notes: 'When the (idempotent) midday follow-up batch should run, HH:mm site-local (after the noon cutoff)' },
    // CR-2026-090: KPI axle qualifier
    { ruleKey: 'kpi_front_and_rear_satisfies_front_brakes', valueJson: false, notes: 'CR-2026-090: whether a brake line covering BOTH axles may satisfy the Front Brakes benchmark component. Default false — a front-and-rear job is more work than that standard was built for, so approving it is a deliberate management decision.' },
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

  // --- v4.1 / CR-2026-008: Vehicle weight + serviceClass suggestions (common makes) ---
  // Advisory only — drives the classification review queue; never auto-applied
  // to Vehicle.serviceClass (staff confirm required, DMAIC Rule 3 fail-safe).
  const weightSuggestions = [
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

  // Idempotent reseed of this config/lookup table.
  await prisma.vehicleWeightSuggestion.deleteMany({});
  for (const ws of weightSuggestions) {
    await prisma.vehicleWeightSuggestion.create({ data: ws });
  }
  console.warn(`Vehicle weight/serviceClass suggestions: ${weightSuggestions.length} seeded`);

  // CR-2026-059 — active Visual Inspection template (without it, starting an
  // inspection fails with "No active inspection template is configured").
  const tpl = await seedInspectionTemplate(prisma);
  console.warn(`Inspection template v${tpl.version}: ${tpl.itemCount} items across ${tpl.categories} categories (active=${tpl.isActive})`);

  // CR-2026-088 — KPI policy v1, the six benchmark combinations, and the default
  // package-component mapping the manager is expected to confirm.
  const kpi = await seedKpiFramework(prisma);
  const skipped = kpi.componentsSkipped.length
    ? ` (skipped: ${kpi.componentsSkipped.join(', ')})`
    : '';
  console.warn(
    `KPI policy v${kpi.version}: ${kpi.benchmarks} benchmarks, ` +
      `${kpi.componentsMapped} service component(s) mapped${skipped}`,
  );

  // CR-2026-096 — customer notification templates. Create-if-missing ONLY: a
  // manager's edited wording is live configuration and must survive reseeds.
  const { DEFAULT_TEMPLATES } = await import(
    '../apps/api/src/modules/notifications/templates/default-templates'
  );
  let templatesCreated = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const exists = await prisma.notificationTemplate.findUnique({
      where: { key: t.key },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.notificationTemplate.create({
      data: {
        key: t.key,
        reason: t.reason,
        channel: t.channel,
        name: t.name,
        subject: t.subject ?? null,
        body: t.body,
      },
    });
    templatesCreated++;
  }
  console.warn(
    `Notification templates: ${templatesCreated} created, ${DEFAULT_TEMPLATES.length - templatesCreated} already present (admin wording preserved)`,
  );

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
