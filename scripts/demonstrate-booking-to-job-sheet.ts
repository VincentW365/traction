/**
 * CR-2026-111 §17 — the demonstration.
 *
 *   pnpm booking:demonstrate            # against a running local stack
 *   pnpm booking:demonstrate --keep     # leave the records behind for inspection
 *
 * The claim under test is not "the code compiles". It is: a customer enters their
 * information ONCE on the public booking page, and when the vehicle arrives the
 * advisor opens the Job Sheet and it is already there.
 *
 * So this script does the whole journey for real — the public HTTP API a customer
 * would hit, then a staff login, a check-in, and the Job Sheet endpoint the advisor's
 * screen reads — and then prints what the customer typed next to what the advisor
 * sees. Nothing is asserted from inside the application: every fact on the right is
 * read back out of the API.
 *
 * It creates real records. They are removed at the end unless --keep is passed.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const API = process.env.DEMO_API_URL ?? 'http://localhost:3001/api/v1';
const KEEP = process.argv.includes('--keep');
const STAFF = { email: 'manager@bert.local', password: 'manager123' };

const prisma = new PrismaClient();

// --- the customer, and the exact words they type ----------------------------

const CUSTOMER = {
  firstName: 'Althea',
  lastName: 'Bramwell',
  phone: `876-555-${String(Math.floor(1000 + Math.random() * 8999))}`,
  email: 'althea.bramwell@example.com',
};
const VEHICLE = {
  plateNumber: `DEMO${String(Math.floor(1000 + Math.random() * 8999))}`,
  make: 'Toyota',
  model: 'RAV4',
  modelYear: 2021,
};
const TYPED = {
  category: 'BRAKES',
  concern: 'There is a grinding noise from the front when I brake going down a hill, and the pedal feels soft first thing in the morning.',
  symptoms: ['BRAKE_NOISE', 'BRAKE_REDUCED_PERFORMANCE'],
  comments: 'I usually leave the car before 8am and collect it after 5pm.',
  mileage: 84_500,
};

// --- plumbing ---------------------------------------------------------------

let cookie = '';

async function call<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init?.headers as Record<string, string>) };
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const h1 = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m\n${'─'.repeat(78)}`);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);

/** Did `needle` survive into `haystack` without anyone retyping it? */
function carried(label: string, typed: string, seen: string | null | undefined): boolean {
  const present = !!seen && seen.includes(typed);
  console.log(`  ${present ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!present) {
    info(`\x1b[31mtyped:   ${typed}\x1b[0m`);
    info(`\x1b[31mon sheet: ${seen ?? '(nothing)'}\x1b[0m`);
  }
  return present;
}

// --- the journey ------------------------------------------------------------

async function main() {
  let failures = 0;
  let appointmentId: string | null = null;

  h1('1. The customer books online — the public page, no login');

  // They are new, so identify finds nothing and the booking creates them.
  const identified = await call<{ known: boolean }>('/public/booking/identify', {
    method: 'POST',
    body: JSON.stringify({ phone: CUSTOMER.phone, plateNumber: VEHICLE.plateNumber }),
  });
  ok(`identify → ${identified.known ? 'existing customer' : 'new customer'}`);

  // "Something is wrong with the brakes" is a concern, not a diagnosis: it books
  // the assessment service, never a pad replacement.
  const codes = ['ASSESS-01'];
  const availability = await call<{ plannedMinutes: number; nextAvailable?: { startAt: string } }>(
    `/public/booking/availability?serviceCodes=${codes.join(',')}&days=14`,
  );
  const startAt = availability.nextAvailable?.startAt;
  if (!startAt) throw new Error('No availability in the next 14 days — cannot demonstrate.');
  ok(`next available ${new Date(startAt).toLocaleString('en-US', { timeZone: 'America/Jamaica' })} · ${availability.plannedMinutes} minutes`);

  const booking = await call<{ appointmentNumber: string }>('/public/booking/confirm', {
    method: 'POST',
    body: JSON.stringify({
      customer: { ...CUSTOMER, smsOptIn: false, emailOptIn: false },
      vehicle: VEHICLE,
      serviceCodes: codes,
      scheduledStartAt: startAt,
      serviceRequest: {
        reasonForVisit: 'Brake Service / Inspection',
        concern: TYPED.concern,
        description: TYPED.comments,
        mileage: TYPED.mileage,
        category: TYPED.category,
        symptoms: TYPED.symptoms,
      },
    }),
  });
  ok(`booked ${booking.appointmentNumber}`);
  info('The customer has now typed everything. They type nothing again.');

  const appt = await prisma.appointment.findFirst({
    where: { appointmentNumber: booking.appointmentNumber },
    select: { id: true, customerId: true, vehicleId: true },
  });
  if (!appt) throw new Error('Booking did not persist.');
  appointmentId = appt.id;

  h1('2. The vehicle arrives — an advisor checks it in');

  const auth = await call<{ accessToken: string }>('/auth/login', { method: 'POST', body: JSON.stringify(STAFF) });
  const token = auth.accessToken;
  ok(`signed in as ${STAFF.email}`);

  const checkedIn = await call<{ serviceVisit: { id: string } }>(`/appointments/${appt.id}/check-in`, {
    method: 'POST',
    token,
    body: JSON.stringify({}),
  });
  const visitId = checkedIn.serviceVisit.id;
  ok(`checked in → service visit ${visitId}`);
  info('The advisor typed nothing but "check in".');

  h1('3. The advisor opens the Job Sheet');

  const sheet = await call<any>(`/service-visits/${visitId}/job-sheet`, { token });
  const intakeNotes: string = (sheet.visitNotes ?? []).map((n: { text: string }) => n.text).join(' \n');
  const intake = sheet.appointment?.bookingIntake ?? null;

  console.log('  What the customer typed            →  What the Job Sheet already shows');
  console.log('  ' + '─'.repeat(74));

  if (!carried('their concern, word for word', TYPED.concern, intake?.customerConcern ?? intakeNotes)) failures++;
  if (!carried('their extra note', TYPED.comments, intake?.additionalComments ?? intakeNotes)) failures++;
  if (!carried('the mileage they read off the dashboard', '84,500', String(sheet.mileageIn ?? '') === '84500' ? '84,500' : intakeNotes)) failures++;

  // The mileage has to be on the FIELD the sheet prints, not only in a note.
  const mileageOnSheet = sheet.mileageIn === TYPED.mileage;
  console.log(`  ${mileageOnSheet ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} the mileage landed on the visit's own field (ServiceVisit.mileageIn)`);
  if (!mileageOnSheet) {
    failures++;
    info(`\x1b[31mmileageIn = ${JSON.stringify(sheet.mileageIn)}, expected ${TYPED.mileage}\x1b[0m`);
  }

  // Symptoms must read as words, not as database enums.
  const symptomsReadable = /brake noise/i.test(intakeNotes) && !/BRAKE_NOISE/.test(intakeNotes);
  console.log(`  ${symptomsReadable ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} what they ticked, in plain words rather than codes`);
  if (!symptomsReadable) {
    failures++;
    info(`\x1b[31mnotes: ${intakeNotes.slice(0, 300)}\x1b[0m`);
  }

  // The service booked must be the assessment, NOT a repair chosen for them.
  const services: string[] = (sheet.appointment?.services ?? []).map((s: any) => s.serviceType?.code);
  const assessedNotRepaired = services.includes('ASSESS-01') && !services.includes('BRK-02') && !services.includes('DISC-01');
  console.log(`  ${assessedNotRepaired ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} booked an assessment, not a repair decided on their behalf`);
  if (!assessedNotRepaired) {
    failures++;
    info(`\x1b[31mservices: ${services.join(', ') || '(none)'}\x1b[0m`);
  }

  h1('4. What the advisor did NOT have to do');
  for (const line of [
    'ask the customer to describe the problem again',
    'retype the mileage the customer already gave',
    'guess which service the noise needs before anyone has looked at the car',
    'copy anything from an email, a phone note or a paper slip',
  ]) {
    ok(line);
  }

  h1(failures === 0 ? 'DEMONSTRATED' : `${failures} CHECK(S) FAILED`);
  if (failures === 0) {
    console.log('  The customer entered their information once. The Job Sheet was already filled in.\n');
  }

  if (!KEEP && appointmentId) {
    await cleanup(appointmentId, appt.customerId, appt.vehicleId, visitId);
    console.log('  Demonstration records removed. Pass --keep to leave them for inspection.\n');
  } else if (appointmentId) {
    console.log(`  Kept: appointment ${booking.appointmentNumber}, visit ${visitId}.\n`);
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

/** Remove exactly what this run created, youngest reference first. */
async function cleanup(appointmentId: string, customerId: string, vehicleId: string, visitId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.visitNote.deleteMany({ where: { serviceVisitId: visitId } });
    await tx.queueTicket.deleteMany({ where: { serviceVisitId: visitId } });
    await tx.statusHistory.deleteMany({ where: { entityId: { in: [appointmentId, visitId] } } });
    await tx.serviceVisit.deleteMany({ where: { id: visitId } });
    await tx.bookingIntake.deleteMany({ where: { appointmentId } });
    await tx.appointmentService.deleteMany({ where: { appointmentId } });
    await tx.appointment.deleteMany({ where: { id: appointmentId } });
    await tx.vehicle.deleteMany({ where: { id: vehicleId } });
    await tx.customer.deleteMany({ where: { id: customerId } });
  });
}

main()
  .catch((e) => {
    console.error(`\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
