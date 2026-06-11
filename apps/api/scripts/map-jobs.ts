/**
 * Service Job Mapping (CR-2026-019, P1b).
 *
 *   (default)            DRY-RUN — classify historical free-text + live structured
 *                        jobs against ServiceCatalogItem; summarise. NO DB writes.
 *                        Reads only. No PII written (redacted, recurring-only samples).
 *   --commit             [GATED] Write ServiceJobMapping rows (idempotent by
 *                        segmentHash, batch-tagged). Requires migration applied.
 *   --rollback <batchId> [GATED] Delete a committed batch.
 *   --threshold <n>      Fuzzy review floor (default 0.6). Fuzzy is NEVER auto-confirmed.
 *
 * Guardrails: source notes never modified; rawText is a copy; fuzzy -> NEEDS_REVIEW;
 * conservative AUTO_MATCH only for exact/normalized; no revenue logic (P1c).
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  splitSegments, buildCatalogIndex, classifyMatch, segmentHash, redact,
  type CatalogRef, type MatchResult,
} from '../src/modules/data-import/service-match';
import { normalizeName } from '../src/modules/data-import/catalog.mapper';

const OUT_DIR = 'demo-output';
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = has('--rollback') ? 'rollback' : has('--commit') ? 'commit' : 'dry-run';
// Owner-approved fuzzy review floor (CR-2026-019 P1b decision A): 0.7. Fuzzy is
// NEVER auto-confirmed (-> NEEDS_REVIEW). Below 0.7 -> UNMAPPED (not persisted).
const THRESHOLD = Number(val('--threshold') ?? '0.7');

async function loadCatalog(prisma: PrismaClient): Promise<CatalogRef[]> {
  const rows = await prisma.serviceCatalogItem.findMany({ select: { id: true, name: true, normalizedName: true, category: true } });
  return rows as CatalogRef[];
}

async function runDryRun() {
  const prisma = new PrismaClient();
  try {
    const catalog = await loadCatalog(prisma);
    const index = buildCatalogIndex(catalog);
    const serviceTypeIdLinked = await prisma.serviceCatalogItem.count({ where: { NOT: { serviceTypeId: null } } });

    // ---- Historical: free-text notes on terminal HISTORICAL_IMPORT orders ----
    const orders = await prisma.serviceOrder.findMany({
      where: { serviceVisit: { sourceType: 'HISTORICAL_IMPORT' } },
      select: { id: true, notes: true },
    });

    let totalSegments = 0;
    const byStatus = { AUTO_MATCHED: 0, NEEDS_REVIEW: 0, UNMAPPED: 0 };
    const byMethod = { EXACT: 0, NORMALIZED: 0, FUZZY: 0, NONE: 0 };
    const segPerOrder: Record<number, number> = {}; // histogram of #segments per order
    let ordersWithAuto = 0, ordersWithOnlyFuzzy = 0, ordersFullyUnmapped = 0, ordersNoSegments = 0;
    const categoriesCovered = new Set<string>();
    const scoreBands = { '>=0.8': 0, '0.7-0.8': 0, '0.6-0.7': 0, '0.5-0.6': 0, '<0.5': 0 }; // for non-auto segments
    const unmatchedFreq = new Map<string, number>();
    const samplesByCategory: Record<string, string[]> = {};

    for (const o of orders) {
      const segs = splitSegments(o.notes);
      segPerOrder[segs.length] = (segPerOrder[segs.length] ?? 0) + 1;
      if (segs.length === 0) { ordersNoSegments++; ordersFullyUnmapped++; continue; }
      let hasAuto = false, hasFuzzy = false;
      for (const seg of segs) {
        totalSegments++;
        const m: MatchResult = classifyMatch(seg, index, THRESHOLD);
        byStatus[m.status]++; byMethod[m.method]++;
        if (m.status === 'AUTO_MATCHED') { hasAuto = true; if (m.category) categoriesCovered.add(m.category); }
        else if (m.status === 'NEEDS_REVIEW') { hasFuzzy = true; if (m.category) categoriesCovered.add(m.category); }
        if (m.status !== 'AUTO_MATCHED') {
          const s = m.confidence;
          if (s >= 0.8) scoreBands['>=0.8']++; else if (s >= 0.7) scoreBands['0.7-0.8']++; else if (s >= 0.6) scoreBands['0.6-0.7']++; else if (s >= 0.5) scoreBands['0.5-0.6']++; else scoreBands['<0.5']++;
        }
        if (m.status === 'UNMAPPED') {
          const key = normalizeName(seg);
          if (key) unmatchedFreq.set(key, (unmatchedFreq.get(key) ?? 0) + 1);
        } else if (m.category) {
          const arr = (samplesByCategory[m.category] ??= []);
          if (arr.length < 3) arr.push(`"${redact(seg, 40)}" -> [${m.category}] (${m.method})`);
        }
      }
      if (hasAuto) ordersWithAuto++; else if (hasFuzzy) ordersWithOnlyFuzzy++; else ordersFullyUnmapped++;
    }

    // Top recurring unmatched (recurring-only + redacted => avoids unique-comment PII)
    const topUnmatched = [...unmatchedFreq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([text, n]) => ({ text: redact(text, 50), count: n }));

    // ---- Live feasibility: ServiceType -> catalog (structured path) ----
    const serviceTypes = await prisma.serviceType.findMany({ select: { id: true, code: true, name: true, family: true } });
    const liveByStatus = { AUTO_MATCHED: 0, NEEDS_REVIEW: 0, UNMAPPED: 0 };
    for (const st of serviceTypes) {
      const m = classifyMatch(st.name, index, THRESHOLD);
      liveByStatus[m.status]++;
    }
    const liveItems = await prisma.serviceOrderItem.count();

    const ordersConsidered = orders.length;
    const readyNowPct = ordersConsidered ? +(100 * ordersWithAuto / ordersConsidered).toFixed(1) : 0;
    const potentialAfterReviewPct = ordersConsidered ? +(100 * (ordersWithAuto + ordersWithOnlyFuzzy) / ordersConsidered).toFixed(1) : 0;

    const report = {
      threshold: THRESHOLD,
      catalogItems: catalog.length,
      historical: {
        ordersConsidered, totalSegments, segPerOrder,
        byStatus, byMethod,
        ordersWithAuto, ordersWithOnlyFuzzy, ordersFullyUnmapped, ordersNoSegments,
        readyNowPct, potentialAfterReviewPct,
        categoryCoverage: `${categoriesCovered.size}/13`,
        scoreBandsForNonAuto: scoreBands,
        topRecurringUnmatched: topUnmatched,
        sampleMappingsByCategory: samplesByCategory,
      },
      live: { serviceTypes: serviceTypes.length, serviceTypeMatch: liveByStatus, serviceOrderItemsInDb: liveItems, serviceTypeIdLinkedInCatalog: serviceTypeIdLinked },
    };

    console.log(`\n=== JOB MAPPING DRY-RUN (threshold=${THRESHOLD}; catalog=${catalog.length}) ===`);
    console.log(`Historical orders considered: ${ordersConsidered}; segments produced: ${totalSegments}`);
    console.log(`Segments by status: ${JSON.stringify(byStatus)}`);
    console.log(`Segments by method: ${JSON.stringify(byMethod)}`);
    console.log(`Segments/order histogram: ${JSON.stringify(segPerOrder)}`);
    console.log(`Orders with >=1 auto-match: ${ordersWithAuto} (${readyNowPct}% ready now) | only-fuzzy: ${ordersWithOnlyFuzzy} | fully unmapped: ${ordersFullyUnmapped} (no-segment: ${ordersNoSegments})`);
    console.log(`Potential analytics-ready after review: ${potentialAfterReviewPct}% | category coverage: ${categoriesCovered.size}/13`);
    console.log(`Non-auto best-score bands: ${JSON.stringify(scoreBands)}`);
    console.log(`Top recurring unmatched (>=3, redacted): ${JSON.stringify(topUnmatched.slice(0, 10))}`);
    console.log(`Sample mappings by category: ${JSON.stringify(report.historical.sampleMappingsByCategory, null, 1)}`);
    console.log(`\nLive feasibility: ${serviceTypes.length} ServiceTypes -> catalog: ${JSON.stringify(liveByStatus)} | ServiceOrderItems in DB: ${liveItems}`);
    console.log(`ServiceType->catalog LINK GAP: catalog rows with serviceTypeId set = ${serviceTypeIdLinked} (expect 0 — link proposed below, not done in P1b)`);

    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, 'job-mapping-dry-run.json');
    writeFileSync(p, JSON.stringify(report, null, 2));
    console.log(`\nFull report (redacted, no raw PII) -> ${p} (gitignored). NO DB writes.`);
  } finally {
    await prisma.$disconnect();
  }
}

async function runCommit() {
  // GATED — only after dry-run review + migration applied.
  const prisma = new PrismaClient();
  const batchId = randomUUID();
  try {
    const catalog = await loadCatalog(prisma);
    const index = buildCatalogIndex(catalog);
    const orders = await prisma.serviceOrder.findMany({ where: { serviceVisit: { sourceType: 'HISTORICAL_IMPORT' } }, select: { id: true, notes: true } });
    let n = 0;
    for (const o of orders) {
      for (const seg of splitSegments(o.notes)) {
        const m = classifyMatch(seg, index, THRESHOLD);
        // Decision D: persist ONLY matched rows (EXACT/NORMALIZED auto + FUZZY>=0.7
        // review). UNMAPPED segments are NOT written (tracked as aggregate counts
        // in the dry-run report) — this also keeps free-text PII out of the DB.
        if (m.status === 'UNMAPPED') continue;
        const hash = segmentHash(o.id, seg);
        // Decision C: redact stored rawText (mask long digit runs) — PII-safe.
        const rawText = redact(seg, 120);
        await (prisma as any).serviceJobMapping.upsert({
          where: { segmentHash: hash },
          update: { status: m.status, matchMethod: m.method, catalogItemId: m.catalogItemId, confidence: m.confidence },
          create: { serviceOrderId: o.id, catalogItemId: m.catalogItemId, rawText, confidence: m.confidence, matchMethod: m.method, status: m.status, segmentHash: hash, importBatchId: batchId },
        });
        n++;
      }
    }
    console.log(`Committed ${n} job mappings (matched only; UNMAPPED not persisted). batchId=${batchId}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function runRollback(batchId: string) {
  const prisma = new PrismaClient();
  try {
    const res = await (prisma as any).serviceJobMapping.deleteMany({ where: { importBatchId: batchId } });
    console.log(`Rolled back batch ${batchId}: deleted ${res.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

(async () => {
  if (MODE === 'dry-run') await runDryRun();
  else if (MODE === 'commit') await runCommit();
  else await runRollback(val('--rollback')!);
})().catch((e) => { console.error('map-jobs error:', e?.message ?? e); process.exit(1); });
