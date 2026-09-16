/**
 * CR-2026-106 — reconcile the merged customer master list (`Customer_List_Master.xlsx`,
 * columns: Source | Customer Name | Customer ID | Phone | Email | Vehicle Plate | Year |
 * Make | Model | VIN) against the target database. READ-ONLY on customers/vehicles;
 * records one ImportRun (mode RECONCILE, system PEACHTREE_CUSTOMER_LIST).
 *
 * Why: the owner's "records were not carried over" most plausibly refers to this list,
 * which merges the SharePoint contacts ("Existing") with 1,693 accounting-only
 * customers ("Peachtree (new)") that no importer has ever loaded (docs/121 §C6). This
 * script says, per source group, how many rows are present in the database by a
 * STABLE key (vehicle code / plate / VIN / phone / email) and how many are not — so
 * the decision to import the Peachtree rows is made on numbers, not on a feeling.
 *
 *   pnpm customers:reconcile:master -- --file "Customer_List_Master.xlsx"
 *   DATABASE_URL=<External URL> pnpm customers:reconcile:master -- --file <path>   # against the deployed DB
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openXlsx } from '../src/modules/data-import/xlsx-lite';
import { normalizePhone, normalizePlate } from '../src/common/helpers/search-terms';

const argv = process.argv.slice(2);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const FILE = val('--file') ?? 'Customer_List_Master.xlsx';
const SHEET = val('--sheet') ?? 'Customers';
const ACTOR = val('--actor') ?? process.env.USERNAME ?? process.env.USER ?? null;
const OUT_DIR = 'demo-output';

type Tier = 'VEHICLE_CODE' | 'PLATE' | 'VIN' | 'PHONE' | 'EMAIL' | 'NOT_PRESENT' | 'NO_KEY';

interface Row {
  n: number;
  source: string;
  name: string;
  customerId: string; // often the SharePoint vehicle code (SC…)
  phone: string;
  email: string;
  plate: string;
  vin: string;
}

function databaseLabel(): string {
  try { const u = new URL(process.env.DATABASE_URL ?? ''); return `${u.hostname}${u.pathname}`; } catch { return 'unknown'; }
}

const clean = (s: string | undefined) => (s ?? '').trim();
const isJunk = (s: string) => !s || /^(0+|n\/?a|none|nil|-|\.|x+)$/i.test(s);

async function main() {
  const wb = openXlsx(FILE);
  const grid = wb.readGrid(SHEET);
  const header = grid[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const ix = { source: col('Source'), name: col('Customer Name'), id: col('Customer ID'), phone: col('Phone'), email: col('Email'), plate: col('Vehicle Plate'), vin: col('VIN') };
  for (const [k, v] of Object.entries(ix)) if (v < 0) throw new Error(`column for ${k} not found in sheet ${SHEET}; header = ${header.join(' | ')}`);

  const rows: Row[] = grid.slice(1).map((r, i) => ({
    n: i + 2,
    source: clean(r[ix.source]) || 'UNKNOWN',
    name: clean(r[ix.name]),
    customerId: clean(r[ix.id]).toUpperCase(),
    phone: normalizePhone(clean(r[ix.phone])),
    email: clean(r[ix.email]).toLowerCase(),
    plate: normalizePlate(clean(r[ix.plate])),
    vin: clean(r[ix.vin]).toUpperCase().replace(/[^A-Z0-9]/g, ''),
  }));
  const blank = rows.filter((r) => !r.name && !r.phone && !r.plate && !r.vin && !r.email && isJunk(r.customerId));
  const data = rows.filter((r) => !blank.includes(r));

  const prisma = new PrismaClient();
  const startedAt = new Date();
  try {
    const chunk = <T>(arr: T[], n = 2000): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    const codes = [...new Set(data.map((r) => r.customerId).filter((c) => /^SC[A-Z0-9-]{2,}$/.test(c)))];
    const plates = [...new Set(data.map((r) => r.plate).filter((p) => p && !isJunk(p)))];
    const vins = [...new Set(data.map((r) => r.vin).filter((v) => v.length >= 6))];
    const phones = [...new Set(data.map((r) => r.phone).filter((p) => p.length >= 7 && !/^0+$/.test(p)))];
    const emails = [...new Set(data.map((r) => r.email).filter((e) => e.includes('@')))];

    const haveCode = new Set<string>(), havePlate = new Set<string>(), haveVin = new Set<string>(), havePhone = new Set<string>(), haveEmail = new Set<string>();
    for (const part of chunk(codes)) for (const v of await prisma.vehicle.findMany({ where: { vehicleCode: { in: part } }, select: { vehicleCode: true } })) haveCode.add(v.vehicleCode);
    for (const part of chunk(plates)) for (const v of await prisma.vehicle.findMany({ where: { plateNumber: { in: part } }, select: { plateNumber: true } })) havePlate.add(v.plateNumber);
    for (const part of chunk(vins)) for (const v of await prisma.vehicle.findMany({ where: { vin: { in: part } }, select: { vin: true } })) if (v.vin) haveVin.add(v.vin);
    for (const part of chunk(phones)) for (const c of await prisma.customer.findMany({ where: { phone: { in: part }, testDataRunId: null }, select: { phone: true } })) havePhone.add(c.phone);
    for (const part of chunk(emails)) for (const c of await prisma.customer.findMany({ where: { email: { in: part, mode: 'insensitive' }, testDataRunId: null }, select: { email: true } })) if (c.email) haveEmail.add(c.email.toLowerCase());

    const tierOf = (r: Row): Tier => {
      if (r.customerId && haveCode.has(r.customerId)) return 'VEHICLE_CODE';
      if (r.plate && havePlate.has(r.plate)) return 'PLATE';
      if (r.vin && haveVin.has(r.vin)) return 'VIN';
      if (r.phone && havePhone.has(r.phone)) return 'PHONE';
      if (r.email && haveEmail.has(r.email)) return 'EMAIL';
      const hasKey = (r.customerId && /^SC/.test(r.customerId)) || (r.plate && !isJunk(r.plate)) || r.vin.length >= 6 || (r.phone.length >= 7 && !/^0+$/.test(r.phone)) || r.email.includes('@');
      return hasKey ? 'NOT_PRESENT' : 'NO_KEY';
    };

    const bySource = new Map<string, Record<Tier, number> & { rows: number }>();
    const exceptions: string[] = ['row,source,tier,customerId,name,phoneMasked,plate'];
    for (const r of data) {
      const t = tierOf(r);
      const g = bySource.get(r.source) ?? { rows: 0, VEHICLE_CODE: 0, PLATE: 0, VIN: 0, PHONE: 0, EMAIL: 0, NOT_PRESENT: 0, NO_KEY: 0 };
      g.rows++;
      g[t]++;
      bySource.set(r.source, g);
      if (t === 'NOT_PRESENT' || t === 'NO_KEY') {
        exceptions.push([r.n, r.source, t, r.customerId, r.name, r.phone ? `***${r.phone.slice(-4)}` : '', r.plate].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
      }
    }

    const lines: string[] = [
      `# Customer master list — reconciliation against the database`,
      ``,
      `Source: \`${basename(FILE)}\` (sheet ${SHEET}) · Database: ${databaseLabel()} · Generated: ${new Date().toISOString()}`,
      ``,
      `| Source group | Rows | Present by vehicle code | by plate | by VIN | by mobile | by email | **Present total** | **Not present** | No usable key |`,
      `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ];
    let totalRows = 0, totalPresent = 0, totalMissing = 0, totalNoKey = 0;
    for (const [src, g] of [...bySource.entries()].sort()) {
      const present = g.VEHICLE_CODE + g.PLATE + g.VIN + g.PHONE + g.EMAIL;
      totalRows += g.rows; totalPresent += present; totalMissing += g.NOT_PRESENT; totalNoKey += g.NO_KEY;
      lines.push(`| ${src} | ${g.rows} | ${g.VEHICLE_CODE} | ${g.PLATE} | ${g.VIN} | ${g.PHONE} | ${g.EMAIL} | **${present}** (${((present / g.rows) * 100).toFixed(1)}%) | **${g.NOT_PRESENT}** | ${g.NO_KEY} |`);
    }
    lines.push(`| **All** | ${totalRows} | | | | | | **${totalPresent}** | **${totalMissing}** | ${totalNoKey} |`);
    lines.push(``);
    lines.push(`Sheet rows: ${rows.length} = ${data.length} data rows + ${blank.length} blank rows. Check: ${data.length === totalRows && totalPresent + totalMissing + totalNoKey === totalRows ? '✓ reconciles' : '✗ DOES NOT RECONCILE'}.`);
    lines.push(``);
    lines.push(`Matching uses stable keys only (vehicle code, plate, VIN, mobile, email); names are never a key. "Not present" rows are listed (masked) in \`${OUT_DIR}/master-list-exceptions.csv\` (git-ignored) for a person to decide whether to import them.`);
    const md = lines.join('\n');
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'master-list-reconciliation.md'), md, 'utf8');
    writeFileSync(join(OUT_DIR, 'master-list-exceptions.csv'), exceptions.join('\r\n'), 'utf8');
    console.warn(md);

    const totals = Object.fromEntries([...bySource.entries()].map(([k, g]) => [k, g]));
    await prisma.importRun.create({
      data: {
        system: 'PEACHTREE_CUSTOMER_LIST',
        mode: 'RECONCILE',
        sourceFile: basename(FILE),
        startedAt,
        finishedAt: new Date(),
        totals: { sheetRows: rows.length, blankRows: blank.length, dataRows: data.length, present: totalPresent, notPresent: totalMissing, noKey: totalNoKey, bySource: totals } as never,
        exceptionsCount: totalMissing + totalNoKey,
        reconciles: data.length === totalRows && totalPresent + totalMissing + totalNoKey === totalRows,
        actor: ACTOR,
        databaseLabel: databaseLabel(),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
