#!/usr/bin/env node
/**
 * SharePoint export  ->  flat CSV
 * --------------------------------------------------------------------------
 * Turns saved SharePoint data into one flat CSV the importer can read.
 * Handles BOTH formats SharePoint hands you with lookups RESOLVED:
 *
 *   • owssvr XMLDATA  — the URL found inside an "Export to Excel" .iqy file:
 *       .../_vti_bin/owssvr.dll?XMLDATA=1&List={GUID}&View={GUID}&RowLimit=0
 *     Returns <z:row ows_Field='id;#Value' .../> rows. Lookups come through
 *     as `id;#DisplayValue` — this script keeps the display value.
 *
 *   • REST JSON       — .../_api/web/lists/getByTitle('..')/items?$expand=<Lookup>&$format=json
 *     Returns { d: { results: [...] } } with expanded lookup objects.
 *
 * WHY THIS EXISTS
 *   Plain "Export to CSV" blanks lookup columns, so the first job-sheet export
 *   had no customer/vehicle identity. Both routes above resolve the lookups;
 *   this script flattens whichever you saved into a usable CSV.
 *
 * HOW TO GET THE DATA (no code, uses your own logged-in browser session)
 *   Easiest: open the downloaded query.iqy in Notepad, copy the long
 *   `https://...owssvr.dll?XMLDATA=1...` URL, paste it into the browser,
 *   press Enter, then Ctrl+S to save the XML (e.g. joblist.xml).
 *
 * USAGE
 *   node scripts/sharepoint/json-to-csv.mjs <out.csv> <input...|folder>
 *     e.g.  node scripts/sharepoint/json-to-csv.mjs jobs.csv joblist.xml
 *           node scripts/sharepoint/json-to-csv.mjs jobs.csv page1.json page2.json
 *
 * Dependency-free (Node 18+ built-ins only).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const NOISE_KEYS = new Set(['__metadata', '__deferred', '__next']);

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

// --- args ---------------------------------------------------------------
const [, , outPath, ...inputs] = process.argv;
if (!outPath || inputs.length === 0) {
  fail('Usage: node scripts/sharepoint/json-to-csv.mjs <out.csv> <input...|folder>');
}

const files = inputs.flatMap((p) => {
  const s = statSync(p, { throwIfNoEntry: false });
  if (!s) fail(`Input not found: ${p}`);
  if (s.isDirectory()) {
    return readdirSync(p)
      .filter((f) => ['.json', '.xml'].includes(extname(f).toLowerCase()))
      .map((f) => join(p, f));
  }
  return [p];
});

// ------------------------------------------------------------------ shared
// SharePoint encodes spaces/punctuation in internal names as _xHHHH_
function decodeSpName(name) {
  return name.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

// A lookup value arrives as "id;#Display" (single) or "id;#A;#id;#B" (multi).
function decodeLookupValue(v) {
  if (typeof v === 'string' && /^\d+;#/.test(v)) {
    const parts = v.split(';#');
    const vals = [];
    for (let i = 1; i < parts.length; i += 2) if (parts[i]) vals.push(parts[i]);
    return vals.join('; ');
  }
  return v;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ------------------------------------------------------------------- JSON
function jsonRows(json) {
  let items;
  if (json && json.d) items = Array.isArray(json.d.results) ? json.d.results : [json.d];
  else if (Array.isArray(json.value)) items = json.value;
  else if (Array.isArray(json)) items = json;
  else fail('Unrecognised JSON shape — expected {d.results}, {value}, or an array.');
  return items.map((it) => flattenJson(it));
}

function flattenJson(item, prefix = '') {
  const out = {};
  for (const [key, val] of Object.entries(item)) {
    if (NOISE_KEYS.has(key) || key.startsWith('@odata') || key.startsWith('odata.')) continue;
    const col = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === undefined) out[col] = '';
    else if (Array.isArray(val))
      out[col] = val
        .map((v) => (v && typeof v === 'object' ? (v.Title ?? v.Value ?? JSON.stringify(v)) : v))
        .join('; ');
    else if (typeof val === 'object') {
      const inner = flattenJson(val, col);
      if (Object.keys(inner).length === 0) out[col] = '';
      else Object.assign(out, inner);
    } else out[col] = val;
  }
  return out;
}

// -------------------------------------------------------------------- XML
function xmlDecode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // amp last
}

// OData Atom feed (what the browser returns from _api/...): each item lives in
// <content...><m:properties> ... <d:Field>value</d:Field> ... </m:properties>.
function atomRows(text) {
  const propsRe = /<content\b[^>]*>\s*<m:properties>([\s\S]*?)<\/m:properties>\s*<\/content>/g;
  // Matches both <d:Name ...>value</d:Name> and self-closing <d:Name m:null="true" />
  const fieldRe = /<d:([\w.\-]+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/d:\1>)/g;
  const rows = [];
  let p;
  while ((p = propsRe.exec(text)) !== null) {
    const block = p[1];
    const row = {};
    let f;
    while ((f = fieldRe.exec(block)) !== null) {
      const name = decodeSpName(f[1]);
      const attrs = f[2] ?? '';
      const isNull = /\bm:null\s*=\s*["']true["']/.test(attrs);
      const raw = f[3] ?? '';
      if (isNull) {
        row[name] = '';
      } else if (raw.includes('<d:element>')) {
        // Multi-value field (e.g. Assigned To): <d:element>A</d:element><d:element>B</d:element>
        row[name] = [...raw.matchAll(/<d:element>([\s\S]*?)<\/d:element>/g)]
          .map((e) => xmlDecode(e[1]))
          .join('; ');
      } else {
        row[name] = decodeLookupValue(xmlDecode(raw));
      }
    }
    if (Object.keys(row).length) rows.push(row);
  }
  if (rows.length === 0) {
    fail('No <m:properties> entries found in the Atom XML. ' +
      '(If it is an error/login page, re-open the URL while signed in.)');
  }
  return rows;
}

function xmlRows(text) {
  // owssvr XMLDATA rows are self-closing <z:row .../> with ows_ attributes.
  const rowRe = /<z:row\b([^>]*?)\/?>/g;
  const attrRe = /([\w:.\-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const attrs = m[1];
    const row = {};
    let a;
    while ((a = attrRe.exec(attrs)) !== null) {
      const rawName = a[1];
      if (!rawName.startsWith('ows_')) continue;
      const name = decodeSpName(rawName.slice(4)); // strip ows_
      const value = decodeLookupValue(xmlDecode(a[2] ?? a[3] ?? ''));
      row[name] = value;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  if (rows.length === 0) {
    fail('No <z:row> elements found in the XML. Is this an owssvr XMLDATA response? ' +
      '(If it is an error/login page, re-open the URL while signed in.)');
  }
  return rows;
}

// --------------------------------------------------------------------- run
const rows = [];
for (const file of files) {
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').trimStart();
  let fileRows;
  if (raw.startsWith('<')) {
    if (raw.includes('z:row')) fileRows = xmlRows(raw);           // owssvr XMLDATA
    else if (raw.includes('m:properties')) fileRows = atomRows(raw); // _api Atom feed
    else fail('Unrecognised XML — expected owssvr <z:row> or OData <m:properties>.');
  } else {
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      fail(`Could not parse ${file} as JSON or XML: ${e.message}`);
    }
    fileRows = jsonRows(json);
  }
  rows.push(...fileRows);
  console.warn(`  • ${file}: ${fileRows.length} rows`);
}

if (rows.length === 0) fail('No rows found across the input files.');

const columns = [];
const seen = new Set();
for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }

const lines = [columns.map(csvEscape).join(',')];
for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c])).join(','));
writeFileSync(outPath, lines.join('\r\n'), 'utf8');

console.warn(`\n  ✓ Wrote ${rows.length} rows × ${columns.length} columns -> ${outPath}`);
console.warn(`    Columns: ${columns.slice(0, 14).join(', ')}${columns.length > 14 ? ', …' : ''}\n`);
