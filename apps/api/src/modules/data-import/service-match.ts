/**
 * Service job-text matching helpers (CR-2026-019, P1b). Pure + dependency-free.
 * Maps free-text/structured service descriptions to ServiceCatalogItem entries.
 *
 * Conservative policy (owner-approved): EXACT/NORMALIZED -> AUTO_MATCHED;
 * FUZZY (>= threshold) -> NEEDS_REVIEW (never auto-confirmed); else UNMAPPED.
 * Source notes are never modified; callers copy only the matched segment.
 */
import { createHash } from 'node:crypto';
import { normalizeName } from './catalog.mapper';

export type MatchMethod = 'EXACT' | 'NORMALIZED' | 'FUZZY' | 'NONE';
export type MatchStatus = 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMAPPED';

export interface CatalogRef {
  id: string;
  name: string;
  normalizedName: string;
  category: string;
}

export interface CatalogIndex {
  exactByLc: Map<string, CatalogRef>;
  byNorm: Map<string, CatalogRef>;
  list: CatalogRef[];
}

export interface MatchResult {
  method: MatchMethod;
  status: MatchStatus;
  catalogItemId: string | null;
  category: string | null;
  confidence: number; // 0..1 (best score considered)
}

const BLOCK_TAG = /<\/(p|div|li|tr|h[1-6])>|<br\s*\/?>/gi;
const ANY_TAG = /<[^>]+>/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ');
}

/** Split merged free-text notes into candidate service segments.
 *  The SharePoint ServiceDetail(s)/Comment are HTML rich-text, so we: strip the
 *  importer prefix, turn block/break tags into segment boundaries, remove all
 *  remaining tags (and thus inline style attributes), decode entities, then split
 *  on SAFE delimiters ( | ; newline ). We do NOT split on / , + & - (catalog names
 *  use them: "AIR/ AC FILTERS", "Oil & Air Filter", "R/R Hub -CAR"). Residual CSS,
 *  number-only, and tag-fragment noise is filtered out. */
export function splitSegments(notes: string | null | undefined): string[] {
  if (!notes) return [];
  let t = notes.replace(/^\s*\[hist[^\]]*\]\s*/i, '');
  t = t.replace(BLOCK_TAG, '\n').replace(ANY_TAG, ' ');
  t = decodeEntities(t);
  return t
    .split(/[|;\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/[^a-z0-9]/gi, '').length >= 3) // drop tiny fragments
    .filter((s) => (s.match(/[a-z]/gi) ?? []).length >= 2); // must have real letters (drops "0 0 0", "585858")
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function dice(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((g) => { if (B.has(g)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((t) => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

/** Similarity in [0,1] — max of char-bigram Dice and token Jaccard on normalized text. */
export function similarity(a: string, b: string): number {
  return Math.max(dice(a, b), tokenJaccard(a, b));
}

export function buildCatalogIndex(catalog: CatalogRef[]): CatalogIndex {
  const exactByLc = new Map<string, CatalogRef>();
  const byNorm = new Map<string, CatalogRef>();
  for (const c of catalog) {
    const lc = c.name.trim().toLowerCase();
    if (!exactByLc.has(lc)) exactByLc.set(lc, c);
    if (c.normalizedName && !byNorm.has(c.normalizedName)) byNorm.set(c.normalizedName, c);
  }
  return { exactByLc, byNorm, list: catalog };
}

export function classifyMatch(rawSegment: string, index: CatalogIndex, threshold: number): MatchResult {
  const lc = rawSegment.trim().toLowerCase();
  const exact = index.exactByLc.get(lc);
  if (exact) return { method: 'EXACT', status: 'AUTO_MATCHED', catalogItemId: exact.id, category: exact.category, confidence: 1 };

  const norm = normalizeName(rawSegment);
  if (norm) {
    const n = index.byNorm.get(norm);
    if (n) return { method: 'NORMALIZED', status: 'AUTO_MATCHED', catalogItemId: n.id, category: n.category, confidence: 1 };
  }

  let best: CatalogRef | null = null;
  let bestScore = 0;
  for (const c of index.list) {
    const s = similarity(norm, c.normalizedName);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (best && bestScore >= threshold) {
    return { method: 'FUZZY', status: 'NEEDS_REVIEW', catalogItemId: best.id, category: best.category, confidence: bestScore };
  }
  return { method: 'NONE', status: 'UNMAPPED', catalogItemId: null, category: null, confidence: bestScore };
}

/** Deterministic idempotency key for a (scope, segment) pair. Re-runs are stable. */
export function segmentHash(scopeId: string, rawSegment: string): string {
  return createHash('sha256').update(`${scopeId}${normalizeName(rawSegment)}`).digest('hex');
}

/** Redact likely-PII (long digit runs) and cap length — for any text surfaced in reports. */
export function redact(s: string, max = 60): string {
  const r = s.replace(/\d{4,}/g, '####').replace(/\s+/g, ' ').trim();
  return r.length > max ? r.slice(0, max - 1) + '…' : r;
}
