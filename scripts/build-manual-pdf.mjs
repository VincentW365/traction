/**
 * Build the printable staff manual from docs/manual/index.html.
 *
 * One source of truth on purpose. The manual is authored once, as the web page
 * staff can open on a tablet; this renders that same file to PDF for the copies
 * that live in the workshop and at the front desk. Nobody has to remember to
 * update two documents, because there is only one.
 *
 * The web page's interactive parts (search box, role tabs, the contents rail)
 * are meaningless on paper, so print hides them and substitutes a printed
 * contents list. Everything else is the page exactly as it renders on screen.
 *
 *   pnpm manual:pdf
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'docs', 'manual', 'index.html');
const OUT = join(ROOT, 'docs', 'manual', 'Traction-Staff-Manual.pdf');

/** Everything that only makes sense with a mouse, plus the paper-only rules. */
const PRINT_CSS = `
  /* Interactive chrome has no meaning on paper. The colour key and the journey
     strip are content, not navigation, so both stay. */
  .toolbar, .rail, .no-hits { display: none !important; }
  .key .role { pointer-events: none; }
  .cols { display: block !important; }
  .wrap { max-width: none !important; padding-inline: 0 !important; padding-block: 0 !important; }

  body { background: #fff !important; font-size: 10.4pt; line-height: 1.5; }
  h1 { font-size: 36pt !important; }
  h2 { font-size: 22pt !important; }
  .sec-num { font-size: 30pt !important; }
  .task h3 { font-size: 15pt !important; }
  .standfirst { font-size: 11pt !important; }
  .masthead { padding-block: 0 0 !important; }

  /* A procedure split across a page turn is a procedure someone gets half of. */
  .task { break-inside: avoid; page-break-inside: avoid; }
  .sec-head, h2, .task-head, .where, .sec-intro { break-after: avoid; page-break-after: avoid; }
  .masthead, .toc, .key, .journey { break-after: avoid; }
  .journey, .key { break-inside: avoid; }
  .t-scroll { overflow: visible !important; }
  table { min-width: 0 !important; }
  tr { break-inside: avoid; }
  .ladder li { break-inside: avoid; }

  /* Links are not clickable on paper; keep them readable as text. */
  a { text-decoration: none !important; }
  .rail a, .role { color: inherit !important; }

  /* Keep the hue on the button chips — the colour is the point — but pin the
     ink, which on screen flips with the theme. */
  .btn { color: #fff !important; }
  th { color: #fff !important; }
  .ladder li::before { color: #fff !important; }
  .task-body ol li::before { color: #fff !important; }
  .tab[aria-pressed="true"] { color: #fff !important; }

  /* Printed contents, built from the page's own section headings. */
  .toc { margin: 0 0 24px; padding: 14px 0 16px; border-top: 1px solid #121c26; border-bottom: 1px solid #121c26; }
  .toc h4 {
    font-family: var(--display); font-size: 12pt; letter-spacing: .14em;
    text-transform: uppercase; color: #7a8896; margin: 0 0 8px; font-weight: 600;
  }
  .toc ol { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 28px; }
  .toc li { display: flex; gap: 10px; padding: 2px 0; break-inside: avoid; }
  .toc .n { font-family: var(--data); font-size: 9pt; color: #1156c0; padding-top: 3px; }
  .toc .t { font-family: var(--display); font-size: 13pt; font-weight: 600; }
`;

const FOOTER = `
  <div style="width:100%;padding:0 14mm;font:8pt 'Segoe UI',system-ui,sans-serif;color:#7d8c9b;
              display:flex;justify-content:space-between;">
    <span>Traction Staff Manual &middot; Bert's Auto Parts Service Centre</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

const source = readFileSync(SOURCE, 'utf8');

// The authored file is an Artifact body: no doctype, html, head or body tags,
// because the platform wraps it. Supply that wrapper here, pin the light theme
// so it prints on white, and let the print rules win by coming last.
const html = `<!doctype html>
<html lang="en" data-theme="light">
<head><meta charset="utf-8"></head>
<body>
${source}
<style>${PRINT_CSS}</style>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.emulateMedia({ colorScheme: 'light', media: 'print' });
await page.setContent(html, { waitUntil: 'networkidle' });

// Web fonts come from Google Fonts. If this machine is offline the declared
// fallback stacks take over and the PDF is still correct, so report it rather
// than failing the build.
const fontsLoaded = await page.evaluate(async () => {
  try {
    await document.fonts.ready;
    return document.fonts.check("700 1em 'Barlow Condensed'") && document.fonts.check("400 1em 'IBM Plex Sans'");
  } catch {
    return false;
  }
});

// Build the printed contents from the page's own headings, so a section added
// to the manual appears here without anyone editing this script.
const sections = await page.evaluate(() => {
  const rows = [];
  for (const s of document.querySelectorAll('section')) {
    const h2 = s.querySelector('h2');
    const num = s.querySelector('.sec-num');
    if (h2) rows.push({ num: num ? num.textContent.trim() : '', title: h2.textContent.trim() });
  }
  const toc = document.createElement('nav');
  toc.className = 'toc';
  toc.innerHTML =
    '<h4>Contents</h4><ol>' +
    rows.map((r) => `<li><span class="n">${r.num}</span><span class="t">${r.title}</span></li>`).join('') +
    '</ol>';
  const anchor = document.querySelector('.masthead');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(toc, anchor.nextSibling);
  return rows.length;
});

const tasks = await page.evaluate(() => document.querySelectorAll('.task').length);

// `--preview` writes a PNG of the print layout beside the PDF. There is no PDF
// viewer in this toolchain, so this is how a change to the manual's styling gets
// checked before it is handed to anyone.
if (process.argv.includes('--preview')) {
  const shot = join(ROOT, 'docs', 'manual', 'print-preview.png');
  await page.setViewportSize({ width: 794, height: 1123 }); // A4 at 96dpi
  // --at=N scrolls N pixels down first, so a styling change further into the
  // manual can be checked without rendering the whole 20 pages.
  const at = (process.argv.find((a) => a.startsWith('--at=')) || '').split('=')[1];
  if (at) await page.evaluate((y) => window.scrollTo(0, y), Number(at));
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`  preview: ${shot}`);
}

try {
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: FOOTER,
    margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
  });
} catch (err) {
  // Windows locks an open PDF, and the natural time to rebuild the manual is
  // right after reading it. A stack trace here reads like a broken build.
  if (err && err.code === 'EBUSY') {
    await browser.close();
    console.error(`\nThe PDF is open in another program and cannot be replaced.\n  ${OUT}\nClose it and run this again.\n`);
    process.exit(1);
  }
  throw err;
}


await browser.close();

const kb = Math.round(statSync(OUT).size / 1024);
console.log(`Traction-Staff-Manual.pdf — ${sections} sections, ${tasks} tasks, ${kb} kB`);
console.log(`  ${OUT}`);
if (!fontsLoaded) {
  console.log('  note: web fonts did not load (offline?) — rendered with the fallback stacks');
}
