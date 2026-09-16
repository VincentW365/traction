/**
 * CR-2026-108 Stage 4F — DEFAULT vs CATALOGUE scheduling-impact analysis.
 *
 *     pnpm booking:duration-impact
 *
 * READ-ONLY. It never writes, and it never changes `appointment_duration_source`:
 * the two models are compared by handing the SAME production availability service
 * two in-memory rule sets. Production stays on DEFAULT throughout.
 *
 * What this answers: "what scheduling behaviour changes?"
 * What it does NOT answer: "what can the workshop physically handle?" The
 * concurrency ceiling is a policy guard, not a validated resource model
 * (docs/122 §A), so a clean simulation here is not permission to accept the
 * resulting volume. That is Stage 5.
 */
import { PrismaClient } from '@prisma/client';
import { BookingAvailabilityService } from '../apps/api/src/modules/scheduling/availability/booking-availability.service';
import { EtaService } from '../apps/api/src/modules/scheduling/eta/eta.service';
import {
  computeAvailabilityDecision,
  maxConcurrentOverlap,
  type ExistingBooking,
  type SlotRules,
} from '../apps/api/src/modules/public-booking/availability.engine';

const DAYS = 14;
const PILOT = ['OIL-01', 'TIR-01', 'BRK-01', 'TIR-02', 'INSP-01', 'CLEAN-01'];
const MS = 60_000;

const prisma = new PrismaClient();
const pct = (a: number, b: number) => (b === 0 ? '--' : `${a > b ? '+' : ''}${Math.round(((a - b) / b) * 1000) / 10}%`);
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const rpad = (s: unknown, n: number) => String(s).padStart(n);

async function main(): Promise<void> {
  const site = await prisma.site.findFirstOrThrow({ where: { isActive: true }, select: { id: true, timezone: true } });
  const eta = new EtaService(prisma as never);
  const avail = new BookingAvailabilityService(prisma as never, eta);
  const base = await avail.loadRules(site.id);

  // Two in-memory rule sets. The DATABASE is untouched.
  const asDefault = { ...base, booking: { ...base.booking, durationSource: 'DEFAULT' as const } };
  const asCatalogue = { ...base, booking: { ...base.booking, durationSource: 'CATALOGUE' as const } };

  const services = await prisma.serviceType.findMany({
    where: { code: { in: PILOT } },
    select: { code: true, name: true, customerFacingName: true, baseDurationMinutes: true, bookingBufferMinutes: true, requiredBayType: true },
  });
  const byCode = new Map(services.map((s) => [s.code, s]));

  console.log('\nCR-2026-108 Stage 4F — DEFAULT vs CATALOGUE impact');
  console.log(`site timezone ${site.timezone} · ${DAYS} days · capacity ${base.eta.capacity} · default ${base.eta.defaultDurationMinutes}m`);
  console.log(`production duration source right now: ${base.booking.durationSource} (unchanged by this analysis)\n`);

  // ---------------------------------------------------------------------------
  // 1. Per service, against the REAL calendar
  // ---------------------------------------------------------------------------
  console.log('--- 1. Bookable start slots per service, next 14 days -----------------');
  console.log(`${pad('Service', 32)}${rpad('cat', 5)}${rpad('def', 5)}${rpad('slots DEF', 11)}${rpad('slots CAT', 11)}${rpad('diff', 8)}${rpad('%', 9)}  first offered (CAT)`);
  const perService: Array<{ code: string; def: number; cat: number }> = [];
  for (const code of PILOT) {
    const s = byCode.get(code)!;
    const [d, c] = await Promise.all([
      avail.availabilityDecision(site, [s], { audience: 'CUSTOMER', days: DAYS, rules: asDefault }),
      avail.availabilityDecision(site, [s], { audience: 'CUSTOMER', days: DAYS, rules: asCatalogue }),
    ]);
    const defN = d.decision.days.reduce((n, x) => n + x.availableCount, 0);
    const catN = c.decision.days.reduce((n, x) => n + x.availableCount, 0);
    perService.push({ code, def: defN, cat: catN });
    const first = c.decision.nextAvailable ? new Date(c.decision.nextAvailable.startAt).toLocaleString('en-US', { timeZone: site.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'none';
    console.log(
      `${pad(s.customerFacingName ?? s.name, 32)}${rpad(s.baseDurationMinutes + 'm', 5)}${rpad(base.eta.defaultDurationMinutes + 'm', 5)}` +
        `${rpad(defN, 11)}${rpad(catN, 11)}${rpad(catN - defN, 8)}${rpad(pct(catN, defN), 9)}  ${first}`,
    );
  }

  // ---------------------------------------------------------------------------
  // 2. The 20-minute grid against 25/30/75-minute jobs
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Slot-grid arithmetic (interval 20m; durations are NOT rounded) --');
  const open = new Date('2026-09-21T13:00:00Z'); // 08:00 local, a Monday
  const close = new Date('2026-09-21T22:00:00Z');
  const day = { dateKey: '2026-09-21', window: { open, close }, isClosedDate: false, isToday: false, latestStart: null };
  const rulesFor = (durationMinutes: number, capacity = 1): SlotRules => ({
    slotIntervalMinutes: base.booking.slotIntervalMinutes,
    minNoticeMinutes: 0,
    sameDayAllowed: true,
    capacity,
    durationMinutes,
    defaultDurationMinutes: base.eta.defaultDurationMinutes,
  });

  const checks: Array<[string, boolean, string]> = [];
  // A 25-minute booking at 10:00 runs to 10:25 and must block a 10:20 start at capacity 1.
  {
    const booked: ExistingBooking[] = [{ startAt: new Date('2026-09-21T15:00:00Z'), endAt: new Date('2026-09-21T15:25:00Z') }];
    const dec = computeAvailabilityDecision(new Date('2026-09-20T12:00:00Z'), [day], booked, rulesFor(25));
    const at1020 = dec.days[0].slots.find((s) => s.startAt === '2026-09-21T15:20:00.000Z');
    checks.push(['25m at 10:00 blocks an overlapping 10:20 start', at1020?.available === false, `${at1020?.reasonCode}`]);
    const at1040 = dec.days[0].slots.find((s) => s.startAt === '2026-09-21T15:40:00.000Z');
    checks.push(['...and 10:40 is free again (no over-blocking)', at1040?.available === true, `${at1040?.reasonCode}`]);
  }
  // A 30-minute job on a 20-minute grid: 10:00-10:30 must block 10:20, not 10:40.
  {
    const booked: ExistingBooking[] = [{ startAt: new Date('2026-09-21T15:00:00Z'), endAt: new Date('2026-09-21T15:30:00Z') }];
    const dec = computeAvailabilityDecision(new Date('2026-09-20T12:00:00Z'), [day], booked, rulesFor(30));
    checks.push(['30m blocks 10:20', dec.days[0].slots.find((s) => s.startAt === '2026-09-21T15:20:00.000Z')?.available === false, '']);
    checks.push(['30m leaves 10:40 free', dec.days[0].slots.find((s) => s.startAt === '2026-09-21T15:40:00.000Z')?.available === true, '']);
  }
  // Back-to-back is not an overlap: 10:00-10:30 and 10:30-11:00 coexist at capacity 1.
  {
    const n = maxConcurrentOverlap(
      [{ startAt: new Date('2026-09-21T15:00:00Z'), endAt: new Date('2026-09-21T15:30:00Z') }],
      new Date('2026-09-21T15:30:00Z'), new Date('2026-09-21T16:00:00Z'), 80,
    );
    checks.push(['back-to-back does not overlap', n === 0, `peak=${n}`]);
  }
  // 75 minutes must not finish after close: last start is 15:45 local (20:45Z) for a 22:00Z close.
  {
    const dec = computeAvailabilityDecision(new Date('2026-09-20T12:00:00Z'), [day], [], rulesFor(75));
    const lastOffered = [...dec.days[0].slots].reverse().find((s) => s.available);
    const endsBy = lastOffered && new Date(lastOffered.endAt) <= close;
    checks.push(['75m never offers a start that finishes after close', !!endsBy, `last start ${lastOffered ? new Date(lastOffered.startAt).toISOString().slice(11, 16) : 'none'}Z`]);
    const over = dec.days[0].slots.filter((s) => s.reasonCode === 'OUTSIDE_OPENING_HOURS').length;
    checks.push(['...and the tail is reported, not silently dropped', over > 0, `${over} slots flagged OUTSIDE_OPENING_HOURS`]);
  }
  // Durations are used as configured, never rounded to the grid.
  {
    const dec = computeAvailabilityDecision(new Date('2026-09-20T12:00:00Z'), [day], [], rulesFor(25));
    const s0 = dec.days[0].slots[0];
    const len = (new Date(s0.endAt).getTime() - new Date(s0.startAt).getTime()) / MS;
    checks.push(['a 25m service occupies 25m, not rounded to 20 or 40', len === 25, `${len}m`]);
  }
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pad(label, 52)} ${detail}`);
  }
  const gridOk = checks.every(([, ok]) => ok);

  // ---------------------------------------------------------------------------
  // 3. Mixed-service day scenarios
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Mixed-service day scenarios (deterministic, not demand forecasts) --');
  const SCENARIOS: Array<[string, string[]]> = [
    ['A short-heavy', ['OIL-01', 'TIR-01', 'OIL-01', 'BRK-01', 'CLEAN-01']],
    ['B mixed', ['OIL-01', 'TIR-02', 'BRK-01', 'INSP-01', 'TIR-01']],
    ['C long-heavy', ['INSP-01', 'TIR-02', 'INSP-01', 'TIR-02']],
  ];
  const latestStart = base.booking.customerLatestStart
    ? new Date(`2026-09-21T${String(Number(base.booking.customerLatestStart.slice(0, 2)) + 5).padStart(2, '0')}:${base.booking.customerLatestStart.slice(3)}:00Z`)
    : null;
  const scenarioDay = { ...day, latestStart };

  console.log(`${pad('Scenario', 16)}${pad('model', 10)}${rpad('accepted', 10)}${rpad('rejected', 10)}${rpad('peak', 6)}${rpad('used min', 10)}${rpad('free min', 10)}  first -> last accepted`);
  const scenarioRows: Array<{ name: string; model: string; accepted: number; peak: number; used: number }> = [];
  for (const [name, mix] of SCENARIOS) {
    for (const model of ['DEFAULT', 'CATALOGUE'] as const) {
      const booked: ExistingBooking[] = [];
      let accepted = 0;
      let rejected = 0;
      let used = 0;
      const times: string[] = [];
      for (const code of mix) {
        const s = byCode.get(code)!;
        const minutes = model === 'CATALOGUE' ? (s.baseDurationMinutes ?? base.eta.defaultDurationMinutes) + s.bookingBufferMinutes : base.eta.defaultDurationMinutes;
        const dec = computeAvailabilityDecision(new Date('2026-09-20T12:00:00Z'), [scenarioDay], booked, rulesFor(minutes, base.eta.capacity));
        const slot = dec.days[0].slots.find((x) => x.available);
        if (!slot) { rejected++; continue; }
        booked.push({ startAt: new Date(slot.startAt), endAt: new Date(slot.endAt) });
        accepted++;
        used += minutes;
        times.push(new Date(slot.startAt).toLocaleTimeString('en-US', { timeZone: site.timezone, hour: 'numeric', minute: '2-digit' }));
      }
      // Peak concurrency across the whole day.
      let peak = 0;
      for (const b of booked) peak = Math.max(peak, maxConcurrentOverlap(booked, b.startAt, b.endAt, base.eta.defaultDurationMinutes));
      const openMinutes = ((close.getTime() - open.getTime()) / MS) * base.eta.capacity;
      scenarioRows.push({ name, model, accepted, peak, used });
      console.log(
        `${pad(name, 16)}${pad(model, 10)}${rpad(accepted, 10)}${rpad(rejected, 10)}${rpad(peak, 6)}${rpad(used, 10)}${rpad(openMinutes - used, 10)}  ${times[0] ?? '--'} -> ${times[times.length - 1] ?? '--'}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 3b. Saturation — how many of each mix does ONE day actually absorb?
  //
  // The slot COUNT above barely moves, because the calendar is nearly empty: with
  // nothing booked, a shorter job only adds the few extra starts that still fit
  // before closing. That understates the change badly. The number management
  // actually needs is how much work a full day can take, so this repeats each mix
  // until the day refuses another booking.
  // ---------------------------------------------------------------------------
  console.log('\n--- 3b. Saturation: bookings ONE day absorbs before refusing ----------');
  console.log(`${pad('Scenario', 16)}${pad('model', 10)}${rpad('accepted', 10)}${rpad('used min', 10)}${rpad('peak', 6)}  change`);
  for (const [name, mix] of SCENARIOS) {
    const results: Record<string, { accepted: number; used: number; peak: number }> = {};
    for (const model of ['DEFAULT', 'CATALOGUE'] as const) {
      const booked: ExistingBooking[] = [];
      let accepted = 0;
      let used = 0;
      // Cycle the mix until the day is full (hard stop guards a logic error).
      for (let i = 0; i < 200; i++) {
        const s = byCode.get(mix[i % mix.length])!;
        const minutes = model === 'CATALOGUE' ? (s.baseDurationMinutes ?? base.eta.defaultDurationMinutes) + s.bookingBufferMinutes : base.eta.defaultDurationMinutes;
        const dec = computeAvailabilityDecision(new Date('2026-09-20T12:00:00Z'), [scenarioDay], booked, rulesFor(minutes, base.eta.capacity));
        const slot = dec.days[0].slots.find((x) => x.available);
        if (!slot) break;
        booked.push({ startAt: new Date(slot.startAt), endAt: new Date(slot.endAt) });
        accepted++;
        used += minutes;
      }
      let peak = 0;
      for (const b of booked) peak = Math.max(peak, maxConcurrentOverlap(booked, b.startAt, b.endAt, base.eta.defaultDurationMinutes));
      results[model] = { accepted, used, peak };
      console.log(
        `${pad(name, 16)}${pad(model, 10)}${rpad(accepted, 10)}${rpad(used, 10)}${rpad(peak, 6)}  ` +
          (model === 'CATALOGUE' ? `${pct(accepted, results.DEFAULT.accepted)} bookings` : ''),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 4. CLEAN-01 — does cleaning consume mechanical capacity?
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. CLEAN-01 effect ------------------------------------------------');
  const clean = byCode.get('CLEAN-01')!;
  console.log(`  Vehicle Cleaning requires bay type: ${clean.requiredBayType}`);
  console.log('  The FIXED capacity model counts service POSITIONS, not bay types, so a');
  console.log('  cleaning booking consumes one of the same positions a repair would —');
  console.log(`  ${Math.round((30 / base.eta.defaultDurationMinutes) * 100)}% of a DEFAULT slot today, and a full position for 30m under CATALOGUE.`);
  console.log('  Whether that is acceptable is a RESOURCE question: no CLEANING resource');
  console.log('  type exists, and inventing one now is Stage 5 work, not Stage 4F.');

  // ---------------------------------------------------------------------------
  // 5. ETA effect
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. ETA effect for the six (planning input, NOT a guaranteed finish) --');
  console.log(`${pad('Service', 32)}${rpad('planned DEF', 13)}${rpad('planned CAT', 13)}${rpad('occupancy CAT', 15)}  initial ETA shifts by`);
  for (const code of PILOT) {
    const s = byCode.get(code)!;
    const cat = (s.baseDurationMinutes ?? base.eta.defaultDurationMinutes) + s.bookingBufferMinutes;
    console.log(
      `${pad(s.customerFacingName ?? s.name, 32)}${rpad(base.eta.defaultDurationMinutes + 'm', 13)}${rpad(cat + 'm', 13)}${rpad(cat + 'm', 15)}  ${cat - base.eta.defaultDurationMinutes > 0 ? '+' : ''}${cat - base.eta.defaultDurationMinutes}m`,
    );
  }
  console.log('  An appointment\'s planned duration is what the scheduler RESERVES. The');
  console.log('  ETA a customer is shown after arrival comes from the live ETA model, which');
  console.log('  re-estimates from actual progress — this column is the starting input only.');

  // ---------------------------------------------------------------------------
  // 6. Conclusion
  // ---------------------------------------------------------------------------
  const totalDef = perService.reduce((n, x) => n + x.def, 0);
  const totalCat = perService.reduce((n, x) => n + x.cat, 0);
  console.log('\n--- 6. Summary ---------------------------------------------------------');
  console.log(`  slot-grid arithmetic          : ${gridOk ? 'all checks pass' : 'FAILURES — see section 2'}`);
  console.log(`  total bookable starts (6 svcs): DEFAULT ${totalDef} -> CATALOGUE ${totalCat} (${pct(totalCat, totalDef)})`);
  const longer = perService.filter((p) => p.cat < p.def).map((p) => p.code);
  console.log(`  services offering FEWER slots : ${longer.length ? longer.join(', ') : 'none'}`);
  console.log('\n  CAVEAT: this describes SCHEDULING behaviour only. The concurrency ceiling');
  console.log('  is a policy guard, not a validated resource model, so more offered slots');
  console.log('  is not evidence the workshop can absorb them. That is Stage 5.\n');
}

main()
  .catch((e) => {
    console.error(`\nFAIL — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
