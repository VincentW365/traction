/**
 * Customer + Vehicle import mapper (CR-2026-003) — PURE functions, no I/O.
 *
 * Maps SharePoint "Contact Database" rows → BSOP Customer/Vehicle shapes, with
 * normalization, name parsing, name+phone dedupe, and edge-case flagging.
 * No Prisma, no fs, no network — fully unit-testable with synthetic fixtures.
 *
 * Source field map (Contact Database):
 *   Title=Customer ID code, field_1=Name, field_2=Phone, field_3=Year, field_4=Make,
 *   field_5=Model, field_6=License/plate, field_7=Engine, field_8=Chassis/VIN,
 *   field_9=Transmission, field_10=Fuel, field_11=Email, field_12=Loyalty, field_13=Drivetrain.
 * The SharePoint item `Id` == jobs.CustomerNo.Id (the future job-import join key).
 */

export interface RawContactRow {
  id: string;
  title: string;
  name: string;
  phone: string;
  year: string;
  make: string;
  model: string;
  plate: string;
  chassis: string;
  email: string;
  loyalty: string;
}

export type ImportFlag =
  | 'MISSING_NAME'
  | 'MISSING_PLATE'
  | 'JUNK_PLATE'
  | 'MISSING_VIN'
  | 'DUPLICATE_PLATE'
  | 'DUPLICATE_VIN'
  | 'SUSPICIOUS_MERGE_PLACEHOLDER_PHONE';

const COMPANY_HINTS = /\b(LTD|LIMITED|LLC|INC|CO|COMPANY|SERVICES?|ENTERPRISES?|AUTO|TRUCKING|HOLDINGS?|GROUP|AGENCY)\b/i;
const JUNK_PLATE_VALUES = new Set(['', '0', '00', '000', 'NA', 'N/A', 'NONE', 'NIL', 'XXX', 'TBA', 'X']);

/** Build a RawContactRow from a parsed CSV record keyed by internal field names. */
export function rawRowFromCsv(r: Record<string, string>): RawContactRow {
  const g = (k: string) => (r[k] ?? '').trim();
  return {
    id: g('Id'),
    title: g('Title'),
    name: g('field_1'),
    phone: g('field_2'),
    year: g('field_3'),
    make: g('field_4'),
    model: g('field_5'),
    plate: g('field_6'),
    chassis: g('field_8'),
    email: g('field_11'),
    loyalty: g('field_12'),
  };
}

/** Digits only (preserves country code). */
export function normalizePhone(s: string): string {
  return (s || '').replace(/\D/g, '');
}

/** A phone that can't discriminate identity (placeholder / too short). */
export function isPlaceholderPhone(s: string): boolean {
  const d = normalizePhone(s);
  if (d.length < 7) return true;
  if (/^0+$/.test(d)) return true;
  return /(000000|0000000)/.test(d) || /8760000000$/.test(d);
}

/** Upper-case, alphanumeric only. */
export function normalizePlate(s: string): string {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isJunkPlate(s: string): boolean {
  const p = normalizePlate(s);
  return JUNK_PLATE_VALUES.has(p) || /^0+$/.test(p) || p.length < 3;
}

/** Upper-case, alphanumeric only; treat junk/too-short as empty. */
export function normalizeVin(s: string): string {
  const v = (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length < 6 || /^0+$/.test(v) || JUNK_PLATE_VALUES.has(v)) return '';
  return v;
}

export function parseYear(s: string): number | null {
  const m = (s || '').match(/(19|20)\d{2}/);
  if (!m) return null;
  const y = Number(m[0]);
  return y >= 1900 && y <= 2100 ? y : null;
}

/** Split a Contact "name" into first/last; companies + joint owners kept whole in lastName. */
export function parseName(raw: string): { firstName: string; lastName: string } {
  const name = (raw || '').trim().replace(/\s+/g, ' ');
  if (!name) return { firstName: '', lastName: '' };
  // Companies and joint owners ("A / B") are kept intact in lastName.
  if (name.includes('/') || COMPANY_HINTS.test(name) || name.includes('&')) {
    return { firstName: '', lastName: name };
  }
  if (name.includes(',')) {
    const [last, first] = name.split(',', 2).map((p) => p.trim());
    return { firstName: first || '', lastName: last || name };
  }
  const parts = name.split(' ');
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Normalized name token for the dedupe key. */
function nameKey(name: string): string {
  return (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Dedupe key = normalized(name)+normalized(phone). When the name is blank, the key
 * is row-unique (never merge anonymous rows).
 */
export function dedupeKey(name: string, phone: string, contactId: string): string {
  const n = nameKey(name);
  if (!n) return `__row_${contactId}`;
  return `${n}|${normalizePhone(phone)}`;
}

/** Deterministic 64-bit FNV-1a → base36. Stable across runs (idempotency). */
export function stableHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & mask;
  }
  return h.toString(36);
}

export function customerNumberFromKey(key: string): string {
  return `BERT-C-${stableHash(key)}`;
}

export function vehicleCode(plate: string, contactId: string): string {
  if (!isJunkPlate(plate)) return `SC-${normalizePlate(plate)}`;
  return `SC-CONTACT-${contactId}`;
}

// ---------------------------------------------------------------------------
// Plan (pure): turn raw rows into an idempotent create/merge plan + flags.
// ---------------------------------------------------------------------------

export interface PlannedVehicle {
  contactId: string;
  customerNumber: string;
  vehicleCode: string;
  plateNumber: string | null;
  vin: string | null;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  flags: ImportFlag[];
}

export interface PlannedCustomer {
  customerNumber: string;
  dedupeKey: string;
  firstName: string;
  lastName: string;
  rawName: string;
  phone: string;
  email: string | null;
  vehicleContactIds: string[];
  suspiciousMerge: boolean;
}

export interface ImportPlan {
  customers: PlannedCustomer[];
  vehicles: PlannedVehicle[];
  flagged: { contactId: string; issues: ImportFlag[]; detail: string }[];
  counts: {
    rowsRead: number;
    customersToCreate: number;
    customerMerges: number; // rows that joined an existing customer
    vehiclesToCreate: number;
    duplicatePlates: number;
    suspiciousMerges: number;
    missingName: number;
    missingOrJunkPlate: number;
    missingVin: number;
    duplicateVin: number;
  };
}

export function planImport(rows: RawContactRow[]): ImportPlan {
  const customers = new Map<string, PlannedCustomer>();
  const vehicles: PlannedVehicle[] = [];
  const plateOwner = new Map<string, string>(); // normalizedPlate -> primary contactId
  const vinOwner = new Map<string, string>(); // normalizedVin -> contactId
  const flagged: { contactId: string; issues: ImportFlag[]; detail: string }[] = [];

  let customerMerges = 0;
  let duplicatePlates = 0;
  let duplicateVin = 0;

  for (const r of rows) {
    const flags: ImportFlag[] = [];
    const key = dedupeKey(r.name, r.phone, r.id);
    const customerNumber = customerNumberFromKey(key);
    const parsed = parseName(r.name);
    if (!nameKey(r.name)) flags.push('MISSING_NAME');

    // Customer dedupe (name + phone)
    let customer = customers.get(key);
    if (!customer) {
      customer = {
        customerNumber,
        dedupeKey: key,
        firstName: parsed.firstName,
        lastName: parsed.lastName || (flags.includes('MISSING_NAME') ? `Contact ${r.id}` : ''),
        rawName: r.name,
        phone: normalizePhone(r.phone),
        email: r.email || null,
        vehicleContactIds: [],
        suspiciousMerge: false,
      };
      customers.set(key, customer);
    } else {
      customerMerges++;
      if (isPlaceholderPhone(r.phone) && !key.startsWith('__row_')) {
        customer.suspiciousMerge = true;
        flags.push('SUSPICIOUS_MERGE_PLACEHOLDER_PHONE');
      }
      if (!customer.email && r.email) customer.email = r.email;
    }
    customer.vehicleContactIds.push(r.id);

    // Vehicle mapping
    const junkPlate = isJunkPlate(r.plate);
    if (!r.plate.trim()) flags.push('MISSING_PLATE');
    else if (junkPlate) flags.push('JUNK_PLATE');
    const normPlate = junkPlate ? '' : normalizePlate(r.plate);

    let vin: string | null = normalizeVin(r.chassis) || null;
    if (!vin) flags.push('MISSING_VIN');
    if (vin && vinOwner.has(vin)) {
      flags.push('DUPLICATE_VIN');
      duplicateVin++;
      vin = null; // vin is unique in schema → drop on collision, keep the row
    } else if (vin) {
      vinOwner.set(vin, r.id);
    }

    // Every contact row becomes its own Vehicle (1:1 with its contactId, so the
    // future job-import join stays unique). Duplicate plates keep the shared plate
    // value (plateNumber is non-unique) but get a disambiguated unique vehicleCode.
    let vCode = vehicleCode(r.plate, r.id);
    if (normPlate && plateOwner.has(normPlate)) {
      vCode = `SC-${normPlate}-${r.id}`;
      flags.push('DUPLICATE_PLATE');
      duplicatePlates++;
    } else if (normPlate) {
      plateOwner.set(normPlate, r.id);
    }

    vehicles.push({
      contactId: r.id,
      customerNumber,
      vehicleCode: vCode,
      plateNumber: normPlate || null,
      vin,
      make: r.make || null,
      model: r.model || null,
      modelYear: parseYear(r.year),
      flags,
    });

    if (flags.length) {
      flagged.push({ contactId: r.id, issues: flags, detail: `${r.name} | ${r.plate} | ${r.chassis}` });
    }
  }

  const customerList = [...customers.values()];

  return {
    customers: customerList,
    vehicles,
    flagged,
    counts: {
      rowsRead: rows.length,
      customersToCreate: customerList.length,
      customerMerges,
      vehiclesToCreate: vehicles.length, // every contact row → its own vehicle
      duplicatePlates,
      suspiciousMerges: customerList.filter((c) => c.suspiciousMerge).length,
      missingName: flagged.filter((f) => f.issues.includes('MISSING_NAME')).length,
      missingOrJunkPlate: flagged.filter((f) => f.issues.includes('MISSING_PLATE') || f.issues.includes('JUNK_PLATE')).length,
      missingVin: flagged.filter((f) => f.issues.includes('MISSING_VIN')).length,
      duplicateVin,
    },
  };
}
