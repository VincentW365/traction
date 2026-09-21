import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-111 — surface checks for the six-step booking flow and the Job Sheet
 * block it feeds.
 *
 * The mapping rules live in `lib/booking-categories.ts` and are tested as pure
 * functions next to it. What is asserted HERE is the wiring that a pure test
 * cannot see: that the page has six steps in the approved order, that a customer
 * can always go back, that changing an earlier answer releases a chosen time when
 * — and only when — it has to, and that the Job Sheet actually reads what the
 * booking wrote. This repository has no DOM renderer, so these are source checks;
 * the behavioural proof is the end-to-end demonstration in docs/126.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const BOOK = 'app/book/page.tsx';
const JOB_SHEET = 'app/(dashboard)/inspections/job-sheet/[visitId]/page.tsx';

describe('§8 — six steps, in the approved order', () => {
  const src = read(BOOK);

  it('Customer → Vehicle → Service → Details → Appointment → Review', () => {
    const order = [...src.matchAll(/\{ key: '(\w+)', label: '([\w ]+)' \}/g)].map((m) => m[1]);
    expect(order).toEqual(['customer', 'vehicle', 'service', 'details', 'appointment', 'review']);
  });

  it('renders every step', () => {
    for (const step of ['customer', 'vehicle', 'service', 'details', 'appointment', 'review']) {
      expect(src, step).toContain(`step === '${step}'`);
    }
  });

  it('gives every step after the first a Back button', () => {
    for (const [step, back] of [
      ['vehicle', 'customer'],
      ['service', 'vehicle'],
      ['details', 'service'],
      ['appointment', 'details'],
      ['review', 'appointment'],
    ]) {
      const re = new RegExp(`onClick=\\{\\(\\) => setStep\\('${back}'\\)\\}[^>]*>Back<`);
      expect(src, `${step} → ${back}`).toMatch(re);
    }
  });

  it('makes a completed step a real button the customer can click', () => {
    expect(src).toMatch(/function Stepper\(/);
    expect(src).toContain('canVisit');
    expect(src).toContain('onClick={() => reachable && onGo(s.key)}');
    // A step they have not earned yet must be inert, not a trap that half-works.
    expect(src).toContain('disabled={!reachable}');
    expect(src).toContain("aria-current={isCurrent ? 'step' : undefined}");
  });

  it('a step is reachable only once everything before it is answered', () => {
    expect(src).toMatch(/return STEPS\.slice\(0, i\)\.every\(\(s\) => complete\[s\.key\]\)/);
  });
});

describe('§9 — changing an earlier answer invalidates only what depends on it', () => {
  const src = read(BOOK);

  it('a chosen time is released when the service changes, and the customer is told why', () => {
    expect(src).toMatch(/function releaseSlot\(because: string\)/);
    expect(src).toContain('has been released because');
    expect(src).toContain('Please choose a time again');
    expect(src).toContain('data-testid="slot-released"');
  });

  it('the time survives an edit that cannot change how long the work takes', () => {
    // applyCodes only releases when schedulingChanged says the booked work differs.
    expect(src).toMatch(/if \(schedulingChanged\(codes, next\)\) releaseSlot\(/);
    // Nothing in the details step touches the slot: no release on concern, symptom
    // or comment edits.
    const details = src.slice(src.indexOf("step === 'details'"), src.indexOf("step === 'appointment'"));
    expect(details).not.toContain('releaseSlot');
    expect(details).not.toContain('setSlot(null)');
  });

  it('changing the vehicle releases the time, because the class can change the length', () => {
    expect(src).toMatch(/function chooseVehicle\([\s\S]*?releaseSlot\('you changed the vehicle'\)/);
  });

  it('re-picking the SAME answer is not treated as a change', () => {
    expect(src).toMatch(/if \(c\.key === categoryKey\) return;/);
    expect(src).toMatch(/if \(id === vehicleId && addNew === addVehicle\) return;/);
  });

  it('symptoms do not survive into a category that never offered them', () => {
    expect(src).toMatch(/setOptionKey\(null\);[\s\S]{0,300}setSymptoms\(\[\]\)/);
  });

  it('a change of customer releases the vehicle choice but keeps the service', () => {
    const identify = src.slice(src.indexOf('async function handleIdentify'), src.indexOf('async function handleConfirm'));
    expect(identify).toContain('setVehicleId');
    expect(identify).toContain('releaseSlot');
    // They still want the same work — do not make them choose it again.
    expect(identify).not.toContain('setCategoryKey(null)');
    expect(identify).not.toContain('setCodes([])');
    expect(identify).not.toContain('setConcern(');
  });
});

describe('§4/§15 — the customer sees services, not the database', () => {
  const src = read(BOOK);

  it('chooses from category cards rather than raw catalogue rows', () => {
    expect(src).toContain('BOOKING_CATEGORIES');
    expect(src).toContain('data-testid="service-categories"');
  });

  it('hard-codes no service code in the page itself', () => {
    // Every code lives in the catalogue module, where it is tested. A code typed
    // into JSX is a code nobody checks against the catalogue.
    const jsx = src.slice(src.indexOf('export default function BookPage'));
    expect(jsx).not.toMatch(/'(GEN-SERV|OIL|BAT|BRK|TIR|INSP|CLEAN|ASSESS|DISC)-\d+'/);
  });

  it('only offers a card whose services can actually be booked online', () => {
    expect(src).toMatch(/const bookable = new Set\(\(servicesQ\.data \?\? \[\]\)\.map\(\(s\) => s\.code\)\)/);
    expect(src).toMatch(/\.every\(\(x\) => bookable\.has\(x\)\)/);
  });

  it('never leaves the customer with a page that cannot book anything', () => {
    expect(src).toContain('useRawServiceList');
    expect(src).toContain('data-testid="service-fallback-list"');
  });
});

describe('§11 — the details step asks once, in the customer\'s language', () => {
  const src = read(BOOK);

  it('asks for mileage, the request, symptoms and comments', () => {
    expect(src).toContain('Current mileage');
    expect(src).toContain('What would you like us to check or service?');
    expect(src).toContain('Have you noticed any of these?');
    expect(src).toContain('Anything else we should know?');
  });

  it('asks the symptom question only where a symptom is meaningful', () => {
    expect(src).toMatch(/\{category\?\.symptoms && category\.symptoms\.length > 0 && \(/);
  });

  it('requires a description when the customer is reporting a problem', () => {
    expect(src).toContain('concernRequired');
    expect(src).toMatch(/details: codes\.length > 0 && \(!concernNeeded \|\| !!concern\.trim\(\)\)/);
  });

  it('does not ask for the reason twice — the card they tapped is the reason', () => {
    expect(src).toMatch(/reasonForVisit: category\?\.title/);
    // The old standalone dropdown is gone.
    expect(src).not.toContain('<option>Routine service</option>');
  });

  it('tells the customer why it is worth answering', () => {
    expect(src).toContain("won't be asked again when you arrive");
  });
});

describe('§14 — the review step can edit every section', () => {
  const src = read(BOOK);

  it('has a section per step, each with its own Edit', () => {
    for (const title of ['Customer', 'Vehicle', 'Service', 'Details', 'Appointment']) {
      expect(src, title).toContain(`<ReviewSection title="${title}"`);
    }
    expect(src).toMatch(/function ReviewSection\(/);
    expect(src).toContain('Edit\n');
  });

  it('shows what will actually be booked, not only the card they tapped', () => {
    expect(src).toContain('label="You chose"');
    expect(src).toContain('label="We will book"');
  });

  // CR-2026-112 — and, for a new customer, not without an email address
  // either: the confirmation email carries the reference and manage link.
  it('cannot confirm without a time, or without an email for a new customer', () => {
    expect(src).toMatch(/disabled=\{busy \|\| !slot \|\| \(isNew && !email\.includes\('@'\)\)\}/);
  });
});

describe('§20 — usable on a phone', () => {
  const src = read(BOOK);

  it('opens the numeric keypad for the mileage', () => {
    expect(src).toMatch(/data-testid="mileage"[\s\S]{0,400}?/);
    const mileage = src.slice(src.indexOf('Current mileage'), src.indexOf('What would you like us to check'));
    expect(mileage).toContain('inputMode="numeric"');
    expect(mileage).toContain('pattern="[0-9]*"');
  });

  it('keeps Continue in reach of a thumb', () => {
    expect(src).toMatch(/function ActionBar\(/);
    expect(src).toContain('sticky bottom-0');
  });

  it('gives every control a thumb-sized target', () => {
    // 44px is the accepted floor; min-h-11 is 44px and min-h-12 is 48px. A
    // multi-row textarea already clears it, so only single-line inputs are checked.
    // Whole self-closing tags: several inputs span multiple lines, and an arrow
    // function inside one contains a `>` that a naive match would stop at.
    const small = [...src.matchAll(/<input\b[\s\S]*?\/>/g)]
      .map((m) => m[0].replace(/\s+/g, ' '))
      .filter((tag) => !/type="(checkbox|radio)"/.test(tag))
      .filter((tag) => !/min-h-1[12]/.test(tag));
    expect(small, 'single-line inputs without a minimum height').toEqual([]);
    expect(src).toContain('min-h-12');
    expect(src).toContain('h-5 w-5'); // checkboxes and radios, not the browser default
  });

  it('stacks the category cards on a narrow screen', () => {
    expect(src).toContain('grid-cols-1 gap-2 sm:grid-cols-2');
  });
});

describe('§6 — the Job Sheet reads what the booking wrote', () => {
  const src = read(JOB_SHEET);

  // JSX escapes the apostrophes, so these match the rendered wording as written.
  const INTAKE_HEADING = 'FROM THE CUSTOMER&apos;S BOOKING';
  const DIRECTIVE_HEADING = 'CUSTOMER&apos;S DIRECTIVE';

  it("shows the customer's booking as its own block", () => {
    expect(src).toContain(INTAKE_HEADING);
  });

  it('keeps it separate from the staff directive, so nobody mistakes one for the other', () => {
    // The customer said it; the advisor authorised it. Merging them would let a
    // customer's description read as approved work scope.
    const intakeAt = src.indexOf(INTAKE_HEADING);
    const directiveAt = src.indexOf(DIRECTIVE_HEADING);
    expect(intakeAt).toBeGreaterThan(-1);
    expect(directiveAt).toBeGreaterThan(-1);
    expect(intakeAt).toBeLessThan(directiveAt);
  });

  it('reads the appointment and the customer-concern notes', () => {
    expect(src).toContain('customerIntake');
    expect(src).toContain('CUSTOMER_CONCERN');
    expect(src).toContain('appointment');
  });

  it('shows symptom codes as plain words', () => {
    expect(src).toContain('readableSymptom');
  });
});

describe('§18 — privacy is unchanged', () => {
  const src = read(BOOK);

  it('the public page still never builds a customer link from the staff origin', () => {
    // window.location.origin remains a FALLBACK behind the server-provided URL only.
    expect(src).toMatch(/done\.manageUrl \?\? \(typeof window !== 'undefined'/);
  });

  it('still shows only masked vehicle plates from the identify response', () => {
    expect(src).toContain('plateMasked');
  });

  it('a failed test-booking session still blocks rather than downgrades', () => {
    expect(src).toContain("uatState === 'failed'");
    expect(src).toContain('This test booking session is invalid or has expired.');
  });
});
