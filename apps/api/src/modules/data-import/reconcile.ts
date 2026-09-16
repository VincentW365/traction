/**
 * CR-2026-106 — formal import reconciliation (docs/121 §C6 / §D "Migration").
 *
 * PURE functions, no I/O. Given what was read from the source file, what the
 * mapper planned, and what the database already holds (looked up by the caller
 * through STABLE keys, never names), produce a table whose rows add up to the
 * source counts, plus an exception list for a person to review.
 *
 * Confidence ladder for "is this planned customer already in the database?":
 *   1. EXACT_KEY      — the deterministic customer number / vehicle code derived from
 *                       the source row (idempotent import key) or an ExternalSystemRef
 *   2. PHONE          — same digits-only mobile number
 *   3. EMAIL          — same email (case-insensitive)
 *   4. PLATE_OR_VIN   — (vehicles) same normalised plate or VIN
 *   5. NAME_REVIEW    — same name AND a supporting attribute (a shared vehicle plate) → REVIEW, never a match
 *   6. NAME_ONLY      — same name only → NOT a match (listed as an exception so nobody merges it by hand blindly)
 *
 * "Do not match people solely by name" and "do not automatically merge uncertain
 * people" are enforced here: only tiers 1–3 count as matched; 5 is an exception.
 */
import type { ImportPlan, PlannedCustomer, PlannedVehicle } from './customer-vehicle.mapper';

export interface SourceCounts {
  /** Data lines in the file (excluding the header). */
  rowsInFile: number;
  /** Rows the CSV parser kept (had enough fields and some content). */
  parsed: number;
  /** Rows dropped by the parser as too short / empty. */
  droppedShortRows: number;
  /** Parsed rows dropped because the SharePoint Id was blank. */
  droppedNoId: number;
}

export interface DbCustomerLookup {
  /** customerNumbers already present (exact key). */
  byCustomerNumber: Set<string>;
  /** digits-only phone → customerNumber(s) present. */
  byPhone: Map<string, string[]>;
  /** lower-cased email → customerNumber(s) present. */
  byEmail: Map<string, string[]>;
  /** lower-cased "first last" → customerNumber(s) present (used ONLY to raise review/name-only exceptions). */
  byName: Map<string, string[]>;
}

export interface DbVehicleLookup {
  byVehicleCode: Set<string>;
  byPlate: Map<string, string[]>; // normalised plate → vehicleCode(s)
  byVin: Map<string, string[]>;
}

export type CustomerTier = 'EXACT_KEY' | 'PHONE' | 'EMAIL' | 'WOULD_CREATE' | 'NAME_REVIEW';
export type VehicleTier = 'EXACT_KEY' | 'PLATE_OR_VIN' | 'WOULD_CREATE';

export interface ReconciliationException {
  kind: 'NAME_REVIEW' | 'NAME_ONLY_CANDIDATE' | 'PHONE_MATCHES_MANY' | 'EMAIL_MATCHES_MANY' | 'PLATE_ON_ANOTHER_VEHICLE' | 'FLAGGED_ROW' | 'DROPPED_ROW';
  key: string; // stable source key (contactId / customerNumber / vehicleCode) — never a name alone
  detail: string; // human-readable, may include names (written only to the git-ignored exceptions CSV)
}

export interface ReconciliationReport {
  source: SourceCounts & { reconciles: boolean };
  customers: {
    planned: number;
    exactKey: number;
    byPhone: number;
    byEmail: number;
    wouldCreate: number;
    nameReview: number;
    reconciles: boolean;
  };
  vehicles: {
    planned: number;
    exactKey: number;
    byPlateOrVin: number;
    wouldCreate: number;
    reconciles: boolean;
  };
  flaggedRows: number;
  exceptions: ReconciliationException[];
  /** Per-customer verdicts (for the exceptions CSV and for --commit's "what will happen"). */
  customerTiers: Map<string, CustomerTier>;
  vehicleTiers: Map<string, VehicleTier>;
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const nameKey = (c: { firstName: string; lastName: string }) => lower(`${c.firstName} ${c.lastName}`).replace(/\s+/g, ' ');

export function classifyCustomer(c: PlannedCustomer, db: DbCustomerLookup, plan: ImportPlan, exceptions: ReconciliationException[]): CustomerTier {
  if (db.byCustomerNumber.has(c.customerNumber)) return 'EXACT_KEY';
  const phone = digits(c.phone);
  if (phone.length >= 7) {
    const hits = db.byPhone.get(phone) ?? [];
    if (hits.length === 1) return 'PHONE';
    if (hits.length > 1) {
      exceptions.push({ kind: 'PHONE_MATCHES_MANY', key: c.customerNumber, detail: `mobile ${phone} is on ${hits.length} existing records (${hits.join(', ')})` });
      return 'NAME_REVIEW';
    }
  }
  const email = lower(c.email);
  if (email) {
    const hits = db.byEmail.get(email) ?? [];
    if (hits.length === 1) return 'EMAIL';
    if (hits.length > 1) {
      exceptions.push({ kind: 'EMAIL_MATCHES_MANY', key: c.customerNumber, detail: `email is on ${hits.length} existing records (${hits.join(', ')})` });
      return 'NAME_REVIEW';
    }
  }
  // Name-based: never a match. Review when a supporting attribute agrees (a planned
  // vehicle plate that already exists on the same-named customer is checked by the caller
  // via the vehicle lookup; here we only know the name collision).
  const sameName = db.byName.get(nameKey(c)) ?? [];
  if (sameName.length > 0) {
    const plates = plan.vehicles.filter((v) => v.customerNumber === c.customerNumber && v.plateNumber).map((v) => v.plateNumber);
    exceptions.push({
      kind: plates.length ? 'NAME_REVIEW' : 'NAME_ONLY_CANDIDATE',
      key: c.customerNumber,
      detail: `${c.firstName} ${c.lastName} matches ${sameName.length} existing record(s) by name only (${sameName.join(', ')}); mobile/email differ — NOT merged`,
    });
    return plates.length ? 'NAME_REVIEW' : 'WOULD_CREATE';
  }
  return 'WOULD_CREATE';
}

export function classifyVehicle(v: PlannedVehicle, db: DbVehicleLookup, exceptions: ReconciliationException[]): VehicleTier {
  if (db.byVehicleCode.has(v.vehicleCode)) return 'EXACT_KEY';
  const plateHits = v.plateNumber ? db.byPlate.get(v.plateNumber) ?? [] : [];
  const vinHits = v.vin ? db.byVin.get(v.vin) ?? [] : [];
  if (plateHits.length || vinHits.length) {
    exceptions.push({
      kind: 'PLATE_ON_ANOTHER_VEHICLE',
      key: v.vehicleCode,
      detail: `plate/VIN already on vehicle code(s) ${[...plateHits, ...vinHits].join(', ')} — import would create a second vehicle record`,
    });
    return 'PLATE_OR_VIN';
  }
  return 'WOULD_CREATE';
}

export function buildReconciliation(source: SourceCounts, plan: ImportPlan, customers: DbCustomerLookup, vehicles: DbVehicleLookup): ReconciliationReport {
  const exceptions: ReconciliationException[] = [];
  const customerTiers = new Map<string, CustomerTier>();
  const vehicleTiers = new Map<string, VehicleTier>();

  for (const c of plan.customers) customerTiers.set(c.customerNumber, classifyCustomer(c, customers, plan, exceptions));
  for (const v of plan.vehicles) vehicleTiers.set(v.vehicleCode, classifyVehicle(v, vehicles, exceptions));
  for (const f of plan.flagged) exceptions.push({ kind: 'FLAGGED_ROW', key: f.contactId, detail: `${f.issues.join(';')} — ${f.detail}` });
  if (source.droppedShortRows || source.droppedNoId) {
    exceptions.push({ kind: 'DROPPED_ROW', key: 'parser', detail: `${source.droppedShortRows} short/empty row(s) and ${source.droppedNoId} row(s) without a SharePoint Id were not imported` });
  }

  const count = <T>(m: Map<string, T>, t: T) => [...m.values()].filter((x) => x === t).length;
  const cust = {
    planned: plan.customers.length,
    exactKey: count(customerTiers, 'EXACT_KEY'),
    byPhone: count(customerTiers, 'PHONE'),
    byEmail: count(customerTiers, 'EMAIL'),
    wouldCreate: count(customerTiers, 'WOULD_CREATE'),
    nameReview: count(customerTiers, 'NAME_REVIEW'),
    reconciles: false,
  };
  cust.reconciles = cust.exactKey + cust.byPhone + cust.byEmail + cust.wouldCreate + cust.nameReview === cust.planned;
  const veh = {
    planned: plan.vehicles.length,
    exactKey: count(vehicleTiers, 'EXACT_KEY'),
    byPlateOrVin: count(vehicleTiers, 'PLATE_OR_VIN'),
    wouldCreate: count(vehicleTiers, 'WOULD_CREATE'),
    reconciles: false,
  };
  veh.reconciles = veh.exactKey + veh.byPlateOrVin + veh.wouldCreate === veh.planned;
  const src = { ...source, reconciles: source.parsed + source.droppedShortRows === source.rowsInFile && source.parsed - source.droppedNoId === plan.counts.rowsRead };

  return { source: src, customers: cust, vehicles: veh, flaggedRows: plan.flagged.length, exceptions, customerTiers, vehicleTiers };
}

/** Counts only — safe to print, commit to docs, or store on ImportRun. */
export function reconciliationTotals(r: ReconciliationReport) {
  const { customerTiers: _c, vehicleTiers: _v, exceptions, ...rest } = r;
  return { ...rest, exceptions: exceptions.length, exceptionKinds: exceptions.reduce<Record<string, number>>((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {}) };
}

export function renderReconciliationMarkdown(r: ReconciliationReport, opts: { sourceFile: string; database: string; mode: string; generatedAt?: Date }): string {
  const s = r.source;
  const c = r.customers;
  const v = r.vehicles;
  const ok = (b: boolean) => (b ? '✓ reconciles' : '✗ DOES NOT RECONCILE');
  const kinds = reconciliationTotals(r).exceptionKinds;
  return [
    `# Customer + Vehicle import — reconciliation (${opts.mode})`,
    ``,
    `Source: \`${opts.sourceFile}\` · Database: ${opts.database} · Generated: ${(opts.generatedAt ?? new Date()).toISOString()}`,
    ``,
    `## Source rows`,
    `| Metric | Count |`,
    `| --- | ---: |`,
    `| Data rows in file | ${s.rowsInFile} |`,
    `| Parsed by the CSV reader | ${s.parsed} |`,
    `| Dropped: short/empty rows | ${s.droppedShortRows} |`,
    `| Dropped: no SharePoint Id | ${s.droppedNoId} |`,
    `| Rows planned (customers+vehicles) | ${s.parsed - s.droppedNoId} |`,
    `| **Check** | ${ok(s.reconciles)} |`,
    ``,
    `## Customers (${c.planned} planned from the source, after name+phone de-duplication)`,
    `| Outcome | Count | Basis |`,
    `| --- | ---: | --- |`,
    `| Already present — exact key | ${c.exactKey} | deterministic customer number from the source row |`,
    `| Already present — matched by mobile | ${c.byPhone} | digits-only phone, exactly one record |`,
    `| Already present — matched by email | ${c.byEmail} | case-insensitive email, exactly one record |`,
    `| Would be created | ${c.wouldCreate} | no stable-key / phone / email match |`,
    `| Needs a person (review) | ${c.nameReview} | same name + supporting attribute, or a mobile/email shared by several records — never merged automatically |`,
    `| **Check** | ${ok(c.reconciles)} | ${c.exactKey}+${c.byPhone}+${c.byEmail}+${c.wouldCreate}+${c.nameReview} = ${c.planned} |`,
    ``,
    `## Vehicles (${v.planned} planned — one per source row)`,
    `| Outcome | Count | Basis |`,
    `| --- | ---: | --- |`,
    `| Already present — exact key | ${v.exactKey} | vehicle code from plate + SharePoint Id |`,
    `| Plate/VIN already on another vehicle | ${v.byPlateOrVin} | listed as an exception; a second record would be created |`,
    `| Would be created | ${v.wouldCreate} | |`,
    `| **Check** | ${ok(v.reconciles)} | ${v.exactKey}+${v.byPlateOrVin}+${v.wouldCreate} = ${v.planned} |`,
    ``,
    `## Exceptions (${r.exceptions.length}; detail in the git-ignored CSV)`,
    `| Kind | Count |`,
    `| --- | ---: |`,
    ...Object.entries(kinds).map(([k, n]) => `| ${k} | ${n} |`),
    ``,
    `Flagged source rows (missing name/plate/VIN, duplicates): ${r.flaggedRows}.`,
    ``,
  ].join('\n');
}

export function exceptionsCsv(r: ReconciliationReport): string {
  const esc = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  return ['kind,key,detail', ...r.exceptions.map((e) => `${e.kind},${esc(e.key)},${esc(e.detail)}`)].join('\r\n');
}
