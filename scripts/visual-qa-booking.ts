/**
 * CR-2026-111 — visual QA for the public booking flow.
 *
 *   pnpm booking:visual-qa
 *
 * Walks the six steps on a phone-sized viewport and reports the things a source
 * test cannot see: content wider than the screen, tap targets under 44px, a
 * category card that renders with no label, an action bar that scrolls away.
 *
 * It books nothing — it stops at Review.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = join(process.cwd(), '.visual-qa', 'cr-2026-111');
const PHONE = { width: 390, height: 844 }; // iPhone 14

const problems: string[] = [];
const note = (s: string) => problems.push(s);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);

/** Anything wider than the viewport makes the page scroll sideways on a phone. */
async function checkNoHorizontalScroll(page: Page, step: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth };
  });
  if (overflow.scrollW > overflow.clientW + 1) {
    note(`${step}: page scrolls sideways (${overflow.scrollW}px of content in ${overflow.clientW}px)`);
  } else {
    ok(`${step}: no sideways scroll`);
  }
}

/**
 * 44px is the accepted floor for something a thumb has to hit.
 *
 * A checkbox is measured by its enclosing LABEL, not by the box: clicking anywhere
 * in a wrapping label toggles the control, so a 20px box inside a 48px row is a
 * 48px target. Measuring the box alone reports a problem that does not exist —
 * and, worse, hides the ones that do behind the noise.
 */
async function checkTapTargets(page: Page, step: string) {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, a, input, select, textarea'))) {
      const type = el.getAttribute('type');
      const target =
        (type === 'checkbox' || type === 'radio') && el.closest('label') ? el.closest('label')! : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // not visible
      if (r.height < 44) {
        const label = (target.textContent ?? '').trim().slice(0, 40) || el.getAttribute('aria-label') || el.tagName;
        out.push(`${label} (${Math.round(r.height)}px)`);
      }
    }
    return [...new Set(out)];
  });
  if (small.length) note(`${step}: ${small.length} target(s) under 44px — ${small.slice(0, 5).join('; ')}`);
  else ok(`${step}: every tap target ≥ 44px`);
}

async function checkNoEmptyCards(page: Page, step: string) {
  const empty = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-testid^="category-"]'))) {
      if (!(el.textContent ?? '').trim()) out.push(el.getAttribute('data-testid') ?? '?');
    }
    return out;
  });
  if (empty.length) note(`${step}: category card(s) with no label — ${empty.join(', ')}`);
  else ok(`${step}: every card is labelled`);
}

/**
 * Two screenshots per step.
 *
 * `-viewport` is what the customer actually sees. `-full` shows the whole form at
 * once, which is more useful for reviewing content — but Chromium stitches a
 * full-page capture from several viewport captures, so a `position: sticky`
 * element (here, the action bar) appears in the MIDDLE of it, and a card can pick
 * up a stale highlight across the seam. Neither is a defect in the page; read the
 * viewport shot when the two disagree.
 */
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, `${name}-viewport.png`) });
  await page.screenshot({ path: join(OUT, `${name}-full.png`), fullPage: true });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: PHONE });
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

  console.log(`\nBooking flow at ${PHONE.width}×${PHONE.height}\n${'─'.repeat(60)}`);

  // --- 1. Customer --------------------------------------------------------
  await page.goto(`${BASE}/book`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Mobile number', { timeout: 30_000 });
  await checkNoHorizontalScroll(page, '1 Customer');
  await checkTapTargets(page, '1 Customer');
  await shot(page, '1-customer');

  // A plate nobody has used, so this stays a NEW customer and books nothing.
  const plate = `QA${Math.floor(1000 + Math.random() * 8999)}`;
  await page.fill('input[inputmode="tel"]', `876-555-${Math.floor(1000 + Math.random() * 8999)}`);
  await page.fill('input.uppercase', plate);
  await page.click('button[type="submit"]');

  // --- 2. Vehicle ---------------------------------------------------------
  await page.waitForSelector('text=Tell us about you', { timeout: 30_000 });
  await checkNoHorizontalScroll(page, '2 Vehicle');
  await checkTapTargets(page, '2 Vehicle');
  await shot(page, '2-vehicle');

  await page.fill('input[autocomplete="given-name"]', 'Visual');
  await page.fill('input[autocomplete="family-name"]', 'Check');
  await page.click('button:has-text("Continue")');

  // --- 3. Service ---------------------------------------------------------
  await page.waitForSelector('[data-testid="service-categories"]', { timeout: 30_000 });
  const cards = await page.locator('[data-testid^="category-"]').count();
  console.log(`  \x1b[36mi\x1b[0m ${cards} category card(s) offered`);
  await checkNoEmptyCards(page, '3 Service');
  await checkNoHorizontalScroll(page, '3 Service');
  await checkTapTargets(page, '3 Service');
  await shot(page, '3-service');

  // A card with follow-up options, to check the second question renders.
  const brakes = page.locator('[data-testid="category-BRAKES"]');
  if (await brakes.count()) {
    await brakes.click();
    await page.waitForSelector('[data-testid="category-options"]', { timeout: 10_000 });
    await checkNoHorizontalScroll(page, '3 Service (options)');
    await shot(page, '3-service-options');
    // "Something is wrong with the brakes" → the assessment path, which demands a concern.
    const concernOption = page.locator('label:has-text("Something is wrong with the brakes")');
    if (await concernOption.count()) await concernOption.click();
  } else {
    note('3 Service: the Brakes card was not offered — check bookableOnline for BRK-01');
    await page.locator('[data-testid^="category-"]').first().click();
  }
  await page.click('button:has-text("Continue")');

  // --- 4. Details ---------------------------------------------------------
  await page.waitForSelector('[data-testid="details-step"]', { timeout: 30_000 });
  await checkNoHorizontalScroll(page, '4 Details');
  await checkTapTargets(page, '4 Details');

  // The numeric keypad has to open for the mileage.
  const inputMode = await page.getAttribute('[data-testid="mileage"]', 'inputmode');
  if (inputMode === 'numeric') ok('4 Details: mileage opens the numeric keypad');
  else note(`4 Details: mileage inputmode is ${inputMode ?? 'unset'}, expected numeric`);

  // The symptom question should be present for a brakes concern.
  const symptoms = await page.locator('[data-testid="symptoms"]').count();
  if (symptoms) ok('4 Details: symptom question shown for this category');
  else note('4 Details: no symptom question — expected one for Brakes');

  await page.fill('[data-testid="mileage"]', '84500');
  await page.fill('[data-testid="concern"]', 'Grinding noise when braking downhill.');
  await shot(page, '4-details');

  // The action bar must stay reachable once the form is long. `isVisible` is not
  // enough — an element far below the fold is "visible" to Playwright. The button
  // has to be INSIDE the viewport while the customer is reading the middle of the form.
  await page.evaluate(() => window.scrollTo(0, Math.round(document.body.scrollHeight / 2)));
  await page.waitForTimeout(200);
  const btn = page.locator('button:has-text("See available times")');
  const box = await btn.boundingBox();
  const inViewport = !!box && box.y >= 0 && box.y + box.height <= PHONE.height + 1;
  if (inViewport) ok(`4 Details: Continue stays pinned in the viewport (y=${Math.round(box!.y)})`);
  else note(`4 Details: the action bar scrolled out of the viewport (${box ? `y=${Math.round(box.y)}, viewport ${PHONE.height}` : 'not rendered'})`);

  await page.click('button:has-text("See available times")');

  // --- 5. Appointment -----------------------------------------------------
  await page.waitForSelector('text=Pick a time', { timeout: 30_000 });
  await page.waitForTimeout(1500); // let availability land
  await checkNoHorizontalScroll(page, '5 Appointment');
  await shot(page, '5-appointment');

  const slot = page.locator('button', { hasText: /^\d{1,2}:\d{2}\s?(AM|PM)$/i }).first();
  if (await slot.count()) {
    await slot.click();
    await page.click('button:has-text("Review booking")');

    // --- 6. Review --------------------------------------------------------
    await page.waitForSelector('[data-testid="review-step"]', { timeout: 30_000 });
    await checkNoHorizontalScroll(page, '6 Review');
    await checkTapTargets(page, '6 Review');
    const edits = await page.locator('[data-testid^="edit-"]').count();
    if (edits >= 5) ok(`6 Review: ${edits} sections, each with Edit`);
    else note(`6 Review: only ${edits} Edit action(s), expected 5`);
    await shot(page, '6-review');

    // --- §9: going back and changing the service must release the time ----
    await page.click('[data-testid="edit-service"]');
    await page.waitForSelector('[data-testid="service-categories"]', { timeout: 10_000 });
    const oil = page.locator('[data-testid="category-OIL_CHANGE"]');
    if (await oil.count()) {
      await oil.click();
      const released = await page.locator('[data-testid="slot-released"]').count();
      if (released) ok('§9: changing the service released the time and said why');
      else note('§9: the time was NOT released after changing the service');
      await shot(page, '7-slot-released');
    }

    // --- §8: a completed step is clickable ---------------------------------
    const vehicleStep = page.locator('[data-testid="step-vehicle"]');
    if (await vehicleStep.isEnabled()) {
      await vehicleStep.click();
      const onVehicle = await page.locator('text=Tell us about you').count();
      if (onVehicle) ok('§8: a completed step in the stepper is clickable');
      else note('§8: clicking a completed step did not go there');
    } else {
      note('§8: the completed Vehicle step was not clickable');
    }
  } else {
    note('5 Appointment: no slots offered — cannot check Review or back-navigation');
  }

  await browser.close();

  console.log(`\n${'─'.repeat(60)}`);
  if (consoleErrors.length) {
    console.log(`\n\x1b[33mBrowser console errors (${consoleErrors.length}):\x1b[0m`);
    for (const e of [...new Set(consoleErrors)].slice(0, 8)) console.log(`  · ${e}`);
  }
  if (problems.length === 0) {
    console.log('\n\x1b[32mNo visual problems found.\x1b[0m');
  } else {
    console.log(`\n\x1b[31m${problems.length} problem(s):\x1b[0m`);
    for (const p of problems) console.log(`  · ${p}`);
    process.exitCode = 1;
  }
  console.log(`\nScreenshots: ${OUT}\n`);
}

main().catch((e) => {
  console.error(`\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\n`);
  process.exitCode = 1;
});
