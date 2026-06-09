#!/usr/bin/env node
/**
 * Baseline operations analytics for the Service Centre.
 * Reads the extracted jobs.csv (from json-to-csv.mjs) and writes a markdown
 * report of real baselines for the DMAIC Measure / Analyze / Control phases.
 *
 * USAGE
 *   node scripts/sharepoint/analyze-jobs.mjs [jobs.csv] [out.md]
 *   defaults: jobs.csv  ->  docs/23_Baseline_Operations_Analytics.md
 *
 * Dependency-free (Node 18+ built-ins). No customer names are present in the
 * source (locked list) — customers are counted by anonymous CustomerNo id.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const inPath = process.argv[2] || 'jobs.csv';
const outPath = process.argv[3] || 'docs/23_Baseline_Operations_Analytics.md';

// --- minimal CSV parser (handles quotes, commas, embedded newlines) --------
function parseCsv(s) {
  const rows = [];
  let f = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { f.push(cur); cur = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { f.push(cur); rows.push(f); f = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || f.length) { f.push(cur); rows.push(f); }
  return rows;
}

const raw = parseCsv(readFileSync(inPath, 'utf8'));
const H = raw[0];
const col = (name) => H.indexOf(name);
const rows = raw.slice(1).filter((r) => r.length >= H.length - 3 && r[col('Id')]);
const get = (r, name) => { const i = col(name); return i >= 0 ? (r[i] ?? '') : ''; };
const N = rows.length;

const pct = (n) => `${((n / N) * 100).toFixed(1)}%`;
const bar = (n, max, width = 28) => '█'.repeat(Math.max(0, Math.round((n / max) * width)));

function tally(fn) {
  const m = new Map();
  for (const r of rows) { const k = fn(r); if (k == null) continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// --- date range / monthly trend -------------------------------------------
const months = tally((r) => (get(r, 'Created') || '').slice(0, 7) || null);
months.sort((a, b) => a[0].localeCompare(b[0]));
const createdDates = rows.map((r) => get(r, 'Created')).filter(Boolean).sort();
const firstDate = createdDates[0]?.slice(0, 10);
const lastDate = createdDates[createdDates.length - 1]?.slice(0, 10);
const monthsSpan = months.length || 1;

// --- status ---------------------------------------------------------------
const status = tally((r) => get(r, 'Status') || '(blank)');
const completed = status.find((s) => s[0] === 'Completed')?.[1] || 0;
const cancelled = status.find((s) => s[0] === 'Cancelled')?.[1] || 0;

// --- oil type -------------------------------------------------------------
const oil = tally((r) => get(r, 'field_3') || '(blank)');

// --- technicians (multi-value "A; B") -------------------------------------
const techCount = new Map();
let multiTech = 0, noTech = 0;
for (const r of rows) {
  const v = get(r, 'field_6').trim();
  if (!v) { noTech++; continue; }
  const techs = v.split(';').map((t) => t.trim()).filter(Boolean);
  if (techs.length > 1) multiTech++;
  for (const t of techs) techCount.set(t, (techCount.get(t) || 0) + 1);
}
const techs = [...techCount.entries()].sort((a, b) => b[1] - a[1]);

// --- service mix from free-text ServiceDetail(s) --------------------------
const CATS = [
  ['Oil change / service', /\b(oil change|engine oil|servic|lube)\b/i],
  ['Filters', /\bfilter/i],
  ['Brakes', /\b(brake|disc|pad|caliper)\b/i],
  ['Alignment', /\balign/i],
  ['Shocks / suspension', /\b(shock|strut|suspension|ball ?joint|control arm)\b/i],
  ['Battery / electrical', /\b(battery|alternator|starter|electric|bulb|light)\b/i],
  ['Belts', /\bbelt/i],
  ['Cooling / radiator', /\b(radiator|coolant|cooling|hose|thermostat|water pump)\b/i],
  ['Transmission', /\b(transmission|gearbox|clutch)\b/i],
  ['Steering / driveline', /\b(rack|pinion|bearing|cv|axle|tie rod|steering)\b/i],
  ['Tyres / wheels', /\b(tyre|tire|wheel|rim|puncture)\b/i],
  ['Cleaning / wash', /\b(clean|wash|detail)\b/i],
];
const catCount = new Map(CATS.map(([n]) => [n, 0]));
let uncategorized = 0;
for (const r of rows) {
  const d = (get(r, 'ServiceDetail(s)') || '') + ' ' + (get(r, 'field_13') || '');
  let matched = false;
  for (const [name, re] of CATS) if (re.test(d)) { catCount.set(name, catCount.get(name) + 1); matched = true; }
  if (!matched && d.trim()) uncategorized++;
}
const cats = [...catCount.entries()].sort((a, b) => b[1] - a[1]);

// --- process signals: pause, rework ---------------------------------------
const paused = rows.filter((r) => get(r, 'JobPause').trim()).length;
const resumed = rows.filter((r) => get(r, 'JobResume').trim()).length;
const rework = rows.filter((r) => get(r, 'RectifyStartTime').trim()).length;

// --- repeat customers (by anonymous CustomerNo id) ------------------------
const custJobs = new Map();
let noCust = 0;
for (const r of rows) {
  const id = get(r, 'CustomerNo.Id').trim();
  if (!id) { noCust++; continue; }
  custJobs.set(id, (custJobs.get(id) || 0) + 1);
}
const custCounts = [...custJobs.values()];
const buckets = { '1 job': 0, '2–5': 0, '6–10': 0, '11–20': 0, '21+': 0 };
for (const c of custCounts) {
  if (c === 1) buckets['1 job']++;
  else if (c <= 5) buckets['2–5']++;
  else if (c <= 10) buckets['6–10']++;
  else if (c <= 20) buckets['11–20']++;
  else buckets['21+']++;
}
const topCust = [...custJobs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

// --- day-of-week (from Created) -------------------------------------------
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = new Map(DOW.map((d) => [d, 0]));
for (const r of rows) {
  const c = get(r, 'Created');
  if (!c) continue;
  const day = DOW[new Date(c).getUTCDay()];
  if (day) dow.set(day, dow.get(day) + 1);
}

// --- mileage data-quality note --------------------------------------------
const mileVals = rows.map((r) => Number(get(r, 'CurrentMileage'))).filter((n) => Number.isFinite(n) && n > 0);
const implausible = mileVals.filter((n) => n > 400000).length;

// --- render markdown ------------------------------------------------------
const L = [];
L.push('# 23 — Service Centre Baseline Operations Analytics');
L.push('');
L.push(`> Generated from \`${inPath}\` (${N.toLocaleString()} jobs, **${firstDate} → ${lastDate}**). ` +
  `Source: SharePoint "Service Center: Job Sheet" via REST extract. ` +
  `Customer identity is locked on the source, so customers are counted by anonymous \`CustomerNo\` id. ` +
  `Re-run: \`node scripts/sharepoint/analyze-jobs.mjs\`.`);
L.push('');
L.push('## Headline');
L.push('');
L.push(`- **${N.toLocaleString()} jobs** over **${monthsSpan} months** (~**${Math.round(N / monthsSpan)}** jobs/month).`);
L.push(`- **Completion rate: ${pct(completed)}** (${completed.toLocaleString()} completed); cancellation **${pct(cancelled)}** (${cancelled}).`);
L.push(`- **${custJobs.size.toLocaleString()} distinct customers**; ${noCust.toLocaleString()} jobs (${pct(noCust)}) had no customer link.`);
L.push(`- **Rework (rectify) rate: ${pct(rework)}** (${rework} jobs); **pauses: ${pct(paused)}** (${paused} jobs).`);
L.push('');

L.push('## Job status');
L.push('');
L.push('| Status | Jobs | Share |');
L.push('| --- | ---: | ---: |');
for (const [k, v] of status) L.push(`| ${k} | ${v.toLocaleString()} | ${pct(v)} |`);
L.push('');

L.push('## Monthly volume trend');
L.push('');
L.push('```');
const maxMonth = Math.max(...months.map((m) => m[1]));
for (const [m, v] of months) L.push(`${m}  ${String(v).padStart(4)}  ${bar(v, maxMonth)}`);
L.push('```');
L.push('');

L.push('## Service mix (keyword scan of Service Detail / Comment)');
L.push('');
L.push('_A job can fall in more than one category; uncategorized = free-text with no keyword match._');
L.push('');
L.push('| Category | Jobs | Share of all jobs |');
L.push('| --- | ---: | ---: |');
for (const [k, v] of cats) L.push(`| ${k} | ${v.toLocaleString()} | ${pct(v)} |`);
L.push(`| _Uncategorized text_ | ${uncategorized.toLocaleString()} | ${pct(uncategorized)} |`);
L.push('');

L.push('## Oil type');
L.push('');
L.push('| Oil type | Jobs | Share |');
L.push('| --- | ---: | ---: |');
for (const [k, v] of oil) L.push(`| ${k} | ${v.toLocaleString()} | ${pct(v)} |`);
L.push('');
const servicingOil = oil.filter(([k]) => k !== 'Not Servicing' && k !== '(blank)').reduce((s, [, v]) => s + v, 0);
L.push(`Oil/lube performed on **${servicingOil.toLocaleString()}** jobs (${pct(servicingOil)}); the rest are "Not Servicing".`);
L.push('');

L.push('## Technician workload');
L.push('');
L.push(`${techs.length} technicians appear; ${multiTech.toLocaleString()} jobs (${pct(multiTech)}) had 2+ technicians; ${noTech.toLocaleString()} jobs (${pct(noTech)}) had none/T.B.A.`);
L.push('');
L.push('| Technician | Jobs worked | |');
L.push('| --- | ---: | --- |');
const maxTech = techs[0]?.[1] || 1;
for (const [k, v] of techs) L.push(`| ${k} | ${v.toLocaleString()} | ${bar(v, maxTech, 20)} |`);
L.push('');

L.push('## Repeat-customer distribution');
L.push('');
L.push('| Jobs per customer | Customers |');
L.push('| --- | ---: |');
for (const [k, v] of Object.entries(buckets)) L.push(`| ${k} | ${v.toLocaleString()} |`);
L.push('');
L.push('**Top customers by job volume (anonymous ids):**');
L.push('');
L.push('| CustomerNo | Jobs |');
L.push('| --- | ---: |');
for (const [k, v] of topCust) L.push(`| #${k} | ${v} |`);
L.push('');

L.push('## Intake by day of week (job created)');
L.push('');
L.push('```');
const maxDow = Math.max(...[...dow.values()]);
for (const d of DOW) L.push(`${d}  ${String(dow.get(d)).padStart(5)}  ${bar(dow.get(d), maxDow)}`);
L.push('```');
L.push('');

L.push('## Process & data-quality notes');
L.push('');
L.push(`- **Pause/resume** is actively used (${paused} pauses, ${resumed} resumes) — confirms the job state machine needs a first-class pause/resume concept.`);
L.push(`- **Rework** (\`RectifyStartTime\`) on ${rework} jobs — low but real; the lifecycle needs a rectify/rework path.`);
L.push(`- **Mileage** is unreliable: ${implausible.toLocaleString()} of ${mileVals.length.toLocaleString()} non-zero readings exceed 400,000 — likely unit confusion or data entry. Treat current odometer values with caution.`);
L.push(`- **Customer identity** absent (source list access-denied); names/models can be backfilled later (see docs/22).`);
L.push('');

writeFileSync(outPath, L.join('\n'), 'utf8');
console.warn(`✓ Wrote report (${N} jobs analysed) -> ${outPath}`);
