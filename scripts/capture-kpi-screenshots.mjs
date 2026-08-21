#!/usr/bin/env node
/**
 * Captures desktop and mobile screenshots of the dev visual-QA routes as review evidence.
 *
 * Usage (dev server must already be running):
 *   pnpm dev                                   # in another terminal, with ENABLE_VISUAL_QA=true
 *   node scripts/capture-kpi-screenshots.mjs [route ...]
 *
 * Routes may be given with or without a leading slash. Under Git Bash / MSYS, pass them
 * WITHOUT one (`dev/visual-qa/kpi`) — MSYS rewrites a leading-slash argument into a
 * Windows path before Node ever sees it. Override the host with BASE_URL.
 *
 * Reuses the repo's existing `playwright` devDependency rather than adding a browser
 * automation stack for this one job. Where Playwright's bundled Chromium is absent, it
 * falls back to whichever Edge or Chrome is installed, driven through Chrome's own
 * `--screenshot` switch — enough to keep the script usable on a machine that has not
 * run `playwright install`.
 *
 * It deliberately does NOT start the dev server. A script that starts a server it did
 * not own leaves stray Node processes behind on failure, and silently captures a build
 * different from the one the reviewer is looking at.
 *
 * Every failure is fatal and exits non-zero: a screenshot run that "succeeds" while
 * quietly producing no file is worse than one that stops, because the missing evidence
 * is only noticed after the review.
 */

import { mkdir, stat, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'kpi-visual-evidence');

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const DEFAULT_ROUTES = ['/dev/visual-qa/kpi'];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'mobile', width: 390, height: 844 },
];

const PROBE_ATTEMPTS = 10;
const PROBE_DELAY_MS = 1500;

/** Chrome's headless screenshot switch renders once; the budget is its only settle window. */
const VIRTUAL_TIME_BUDGET_MS = 8000;

class FatalError extends Error {}

function slugify(route) {
  const s = route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-');
  return s.length > 0 ? s.toLowerCase() : 'root';
}

/* ------------------------------- server probing ------------------------------- */

/**
 * Separates "the dev server is not running" from "the route is not there", because the
 * two have completely different fixes and a generic "could not reach" sends people to
 * restart a server that was already up.
 */
async function probeRoute(route) {
  const url = `${BASE_URL}${route}`;
  let lastNetworkError = null;

  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      lastNetworkError = err;
      if (attempt < PROBE_ATTEMPTS) {
        process.stdout.write(`  probing ${url} … attempt ${attempt}/${PROBE_ATTEMPTS}\n`);
        await sleep(PROBE_DELAY_MS);
        continue;
      }
      throw new FatalError(
        `Cannot reach ${url} — ${lastNetworkError?.message ?? 'connection failed'}.\n` +
          `The dev server is not answering on ${BASE_URL}.\n` +
          `Start it first, from the repo root:\n\n` +
          `    ENABLE_VISUAL_QA=true pnpm dev\n\n` +
          `then re-run this script. It does not start the server itself.`,
      );
    }

    if (res.status >= 200 && res.status < 400) return;

    if (res.status === 404) {
      throw new FatalError(
        `${url} returned 404. The dev server is up, so the route itself is not being served.\n` +
          `If this is a /dev/visual-qa route, it is gated: it renders only when NODE_ENV is not\n` +
          `"production" AND ENABLE_VISUAL_QA=true is set for the web app. Restart with the flag:\n\n` +
          `    ENABLE_VISUAL_QA=true pnpm dev\n\n` +
          `Otherwise check the path spelling.`,
      );
    }

    // A 5xx during a dev rebuild is transient; keep retrying until the attempts run out.
    if (attempt < PROBE_ATTEMPTS) {
      process.stdout.write(`  ${url} → HTTP ${res.status}, retrying ${attempt}/${PROBE_ATTEMPTS}\n`);
      await sleep(PROBE_DELAY_MS);
      continue;
    }
    throw new FatalError(`${url} returned HTTP ${res.status} after ${PROBE_ATTEMPTS} attempts.`);
  }
}

/* ------------------------------ browser discovery ----------------------------- */

function windowsBrowserCandidates() {
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const localAppData = process.env.LOCALAPPDATA;

  return [
    programFilesX86 && join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFiles && join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    localAppData && join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFiles && join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFilesX86 && join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData && join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

/**
 * Playwright first: it owns a pinned Chromium and can capture the full scroll height,
 * which matters here because the QA page is far taller than any viewport.
 */
async function resolveDriver() {
  // CAPTURE_DRIVER=chrome-cli forces the fallback, which is otherwise unreachable on any
  // machine that has Playwright's browsers and so could rot untested.
  if (process.env.CAPTURE_DRIVER !== 'chrome-cli') {
    try {
      const playwright = await import('playwright');
      const executablePath = playwright.chromium.executablePath();
      if (executablePath && existsSync(executablePath)) {
        return { kind: 'playwright', executablePath, chromium: playwright.chromium };
      }
    } catch {
      // Falls through to the installed-browser scan below.
    }
  }

  const candidates = windowsBrowserCandidates();
  const found = candidates.find((p) => existsSync(p));
  if (found) return { kind: 'chrome-cli', executablePath: found };

  throw new FatalError(
    'No Chromium-family browser found.\n' +
      'Playwright has no downloaded Chromium, and none of these exist:\n' +
      candidates.map((p) => `  ${p}`).join('\n') +
      '\n\nEither install Microsoft Edge or Google Chrome, or run:\n\n' +
      '    pnpm exec playwright install chromium\n',
  );
}

/* --------------------------------- capturing ---------------------------------- */

async function captureWithPlaywright(driver, jobs) {
  const browser = await driver.chromium.launch({
    headless: true,
    args: ['--disable-gpu'],
  });
  try {
    for (const job of jobs) {
      const context = await browser.newContext({
        viewport: { width: job.viewport.width, height: job.viewport.height },
        deviceScaleFactor: 1,
        isMobile: job.viewport.name === 'mobile',
        hasTouch: job.viewport.name === 'mobile',
      });
      const page = await context.newPage();
      try {
        const res = await page.goto(job.url, { waitUntil: 'networkidle', timeout: 45_000 });
        if (res && res.status() >= 400) {
          throw new FatalError(`${job.url} returned HTTP ${res.status()} in the browser.`);
        }
        await page.screenshot({ path: job.outPath, fullPage: true });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/**
 * Chrome's own screenshot switch. Captures the viewport only, so the evidence is a
 * fold-height crop rather than the whole page — acceptable as a fallback, not as the
 * default. Each capture needs its own user-data-dir or concurrent runs fight over one
 * profile lock.
 */
async function captureWithChromeCli(driver, jobs) {
  for (const [i, job] of jobs.entries()) {
    const profileDir = join(OUT_DIR, `.chrome-profile-${i}`);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      `--window-size=${job.viewport.width},${job.viewport.height}`,
      `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
      `--screenshot=${job.outPath}`,
      job.url,
    ];

    const code = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(driver.executablePath, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', rejectPromise);
      child.on('exit', (exitCode) => resolvePromise(exitCode ?? 0));
    });

    await rm(profileDir, { recursive: true, force: true });

    if (code !== 0) {
      throw new FatalError(`Browser exited with code ${code} while capturing ${job.url}.`);
    }
  }
}

/* ----------------------------------- driver ----------------------------------- */

async function main() {
  const routes = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = routes.length > 0 ? routes.map((r) => (r.startsWith('/') ? r : `/${r}`)) : DEFAULT_ROUTES;

  console.log(`Base URL      : ${BASE_URL}`);
  console.log(`Routes        : ${targets.join(', ')}`);
  console.log(`Output        : ${OUT_DIR}`);
  console.log('');

  console.log('Probing routes…');
  for (const route of targets) {
    await probeRoute(route);
    console.log(`  ok  ${BASE_URL}${route}`);
  }
  console.log('');

  const driver = await resolveDriver();
  console.log(`Browser       : ${driver.executablePath}`);
  console.log(`Driver        : ${driver.kind === 'playwright' ? 'playwright (full-page)' : 'chrome --screenshot (viewport only)'}`);
  console.log('');

  await mkdir(OUT_DIR, { recursive: true });

  const jobs = [];
  for (const route of targets) {
    for (const viewport of VIEWPORTS) {
      const name = `${slugify(route)}-${viewport.name}-${viewport.width}x${viewport.height}.png`;
      const outPath = join(OUT_DIR, name);
      await rm(outPath, { force: true }); // a stale file must never pass the size check
      jobs.push({ url: `${BASE_URL}${route}`, viewport, outPath, name });
    }
  }

  console.log('Capturing…');
  if (driver.kind === 'playwright') {
    await captureWithPlaywright(driver, jobs);
  } else {
    await captureWithChromeCli(driver, jobs);
  }

  const failures = [];
  for (const job of jobs) {
    let size = 0;
    try {
      size = (await stat(job.outPath)).size;
    } catch {
      failures.push(`${job.name} — no file was written`);
      continue;
    }
    if (size === 0) {
      failures.push(`${job.name} — file is zero bytes`);
      continue;
    }
    console.log(`  ${job.name}  ${size.toLocaleString('en-GB')} bytes`);
  }

  if (failures.length > 0) {
    throw new FatalError(`Capture produced unusable output:\n${failures.map((f) => `  ${f}`).join('\n')}`);
  }

  const written = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.png'));
  console.log(`\n${jobs.length} screenshot(s) captured; ${written.length} PNG(s) in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`\n${err instanceof FatalError ? err.message : `Screenshot capture failed: ${err?.stack ?? err}`}`);
  process.exit(1);
});
