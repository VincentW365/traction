/**
 * One-off: for each name in ExportedCustomers.csv, find the customer's highest
 * recorded mileage (max non-zero mileageIn across their service visits) by NAME ONLY.
 *
 *   pnpm --filter @bsop/api exec tsx scripts/match-exported-mileage.ts <in.csv> <out.csv>
 *
 * Name match is case- and word-order-insensitive (normalize → uppercase, strip
 * punctuation, sort tokens) so "ABENA CHANCE" == "Chance, Abena". Ambiguous names
 * (same normalized name on >1 customer) are flagged MULTIPLE, not guessed. Output
 * is PII — keep it local; do not commit/push.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const IN = process.argv[2];
const OUT = process.argv[3];
if (!IN || !OUT) { console.error('Usage: tsx match-exported-mileage.ts <in.csv> <out.csv>'); process.exit(1); }

const prisma = new PrismaClient();

/** Quote-aware split of one CSV line. */
function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const nameKey = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;

(async () => {
  // --- read input ---
  const lines = fs.readFileSync(IN, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  lines.shift(); // header: CustomerID, Last_Name(full name), Email, PrimaryContact
  const inputs = lines.map((l) => { const f = splitCsv(l); return { exportId: f[0] ?? '', name: f[1] ?? '' }; });

  // --- DB name index ---
  const customers = await prisma.customer.findMany({ select: { id: true, customerNumber: true, firstName: true, lastName: true } });
  const idx = new Map<string, { id: string; customerNumber: string }[]>();
  for (const c of customers) {
    const k = nameKey(`${c.firstName} ${c.lastName}`);
    (idx.get(k) ?? idx.set(k, []).get(k)!).push({ id: c.id, customerNumber: c.customerNumber });
  }

  // --- match + collect matched ids ---
  const matchedIds = new Set<string>();
  const results = inputs.map((r) => {
    const hits = idx.get(nameKey(r.name)) ?? [];
    if (hits.length === 1) matchedIds.add(hits[0].id);
    return { ...r, hits };
  });

  // --- highest mileage per matched customer (+ plate + date of that reading) ---
  const ids = [...matchedIds];
  const visits = ids.length
    ? await prisma.serviceVisit.findMany({
        where: { customerId: { in: ids }, mileageIn: { not: null } },
        select: { customerId: true, mileageIn: true, checkedInAt: true, createdAt: true, vehicle: { select: { plateNumber: true } } },
      })
    : [];
  const best = new Map<string, { mileage: number; plate: string; date: Date | null }>();
  for (const v of visits) {
    const m = v.mileageIn ?? 0;
    const cur = best.get(v.customerId);
    if (!cur || m > cur.mileage) best.set(v.customerId, { mileage: m, plate: v.vehicle?.plateNumber ?? '', date: v.checkedInAt ?? v.createdAt ?? null });
  }

  // --- write output ---
  const rows = ['"CustomerID","Name","MatchStatus","DB_CustomerNumber","HighestMileage","Vehicle","ReadingDate"'];
  let matched = 0, withMileage = 0, multiple = 0, noMatch = 0;
  for (const r of results) {
    if (r.hits.length === 1) {
      matched++;
      const b = best.get(r.hits[0].id);
      if (b && b.mileage > 0) withMileage++;
      rows.push([esc(r.exportId), esc(r.name), esc('MATCHED'), esc(r.hits[0].customerNumber),
        esc(b ? b.mileage : ''), esc(b?.plate ?? ''), esc(b?.date ? b.date.toISOString().slice(0, 10) : '')].join(','));
    } else if (r.hits.length > 1) {
      multiple++;
      rows.push([esc(r.exportId), esc(r.name), esc(`MULTIPLE (${r.hits.length})`), '', '', '', ''].join(','));
    } else {
      noMatch++;
      rows.push([esc(r.exportId), esc(r.name), esc('NO_MATCH'), '', '', '', ''].join(','));
    }
  }
  fs.writeFileSync(OUT, rows.join('\n') + '\n', 'utf8');
  console.log(`input rows: ${results.length}`);
  console.log(`  MATCHED:  ${matched} (with a real mileage reading: ${withMileage})`);
  console.log(`  MULTIPLE: ${multiple} (same name on >1 customer — not guessed)`);
  console.log(`  NO_MATCH: ${noMatch}`);
  console.log(`wrote ${OUT}`);
})().catch((e) => { console.error(`ERROR: ${e?.message ?? e}`); process.exit(1); }).finally(() => prisma.$disconnect());
