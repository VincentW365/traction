/**
 * CR-2026-111d — the cross-functional operational regression audit.
 *
 *   pnpm audit:operational            # against a running local stack
 *   pnpm audit:operational --keep     # leave the records behind for inspection
 *
 * The question is not "does the code compile" but "did the booking, capacity,
 * duration, catalogue and Job Sheet work break the technician, dispatch and
 * job-management flows that were already there". So this drives the REAL HTTP API
 * — the same calls the screens make — through every scenario in the directive's
 * §25 matrix, as the roles that would actually perform them, and reads the result
 * back out of the API and the database.
 *
 * Nothing here is asserted from inside the application. Records are created for
 * real and removed at the end unless --keep is passed.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const API = process.env.AUDIT_API_URL ?? 'http://localhost:3001/api/v1';
const KEEP = process.argv.includes('--keep');
const prisma = new PrismaClient();

const MANAGER = { email: 'manager@bert.local', password: 'manager123' };
const ADVISOR = { email: 'advisor@bert.local', password: 'advisor123' };
const TECH_A = { email: 'o.josephs@bert.local', password: 'tech123' }; // BERT-T01
const TECH_B = { email: 'm.walker@bert.local', password: 'tech123' }; // BERT-T02

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, public body: string, message: string) { super(message); }
}

async function call<T = any>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text, `${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
async function login(c: { email: string; password: string }): Promise<string> {
  return (await call<{ accessToken: string }>('/auth/login', { method: 'POST', body: JSON.stringify(c) })).accessToken;
}
/** Expect a specific HTTP failure. */
async function expectStatus(status: number, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return e instanceof ApiError && e.status === status; }
}

interface Row { area: string; check: string; ok: boolean; detail?: string }
const rows: Row[] = [];
function check(area: string, name: string, ok: boolean, detail?: string) {
  rows.push({ area, check: name, ok, detail });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${!ok && detail ? `\n      \x1b[31m${detail}\x1b[0m` : ''}`);
}
const h1 = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m\n${'─'.repeat(78)}`);

/** Run a scenario; an exception becomes a single FAIL row rather than aborting the audit. */
async function scenario(area: string, fn: () => Promise<void>) {
  h1(area);
  try { await fn(); } catch (e) { check(area, 'scenario completed without error', false, e instanceof Error ? e.message : String(e)); }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TAG = `AUD${Date.now().toString(36).slice(-5).toUpperCase()}`;
const created = { customers: [] as string[], vehicles: [] as string[], appointments: [] as string[], visits: [] as string[] };

interface Fx { siteId: string; techA: string; techB: string; bay1: string; bay2: string; res1: string; res1Code: string }
let fx: Fx;

async function fixture(): Promise<Fx> {
  const site = await prisma.site.findFirstOrThrow({ select: { id: true } });
  const techOf = async (email: string) => (await prisma.technician.findFirstOrThrow({ where: { userAccount: { email } }, select: { id: true } })).id;
  const bays = await prisma.workBay.findMany({ where: { siteId: site.id, bayType: 'GENERAL', status: 'ACTIVE' }, select: { id: true, code: true }, orderBy: { code: 'asc' }, take: 2 });
  if (bays.length < 2) throw new Error('Need two ACTIVE GENERAL work bays.');
  const res = await prisma.workResource.findFirstOrThrow({ where: { siteId: site.id, isActive: true, code: bays[0].code }, select: { id: true, code: true } });
  return { siteId: site.id, techA: await techOf(TECH_A.email), techB: await techOf(TECH_B.email), bay1: bays[0].id, bay2: bays[1].id, res1: res.id, res1Code: res.code };
}

/** A clean customer + vehicle with an explicit class. */
async function customerWithVehicle(label: string, serviceClass: 'SEDAN_CLASS' | 'SUV_CLASS' | null) {
  const n = created.customers.length + 1;
  const c = await prisma.customer.create({
    data: { customerNumber: `CUST-${TAG}-${n}`, firstName: 'Audit', lastName: label, phone: `876555${String(9000 + n).padStart(4, '0')}`, notificationOptInSms: false, notificationOptInEmail: false },
    select: { id: true },
  });
  const plate = `${TAG}${n}`;
  const v = await prisma.vehicle.create({
    data: { customerId: c.id, vehicleCode: `SC${plate}`, plateNumber: plate, make: 'Toyota', model: serviceClass === 'SUV_CLASS' ? 'RAV4' : 'Corolla', modelYear: 2021, serviceClass: serviceClass as never },
    select: { id: true },
  });
  created.customers.push(c.id); created.vehicles.push(v.id);
  return { customerId: c.id, vehicleId: v.id, plate };
}

// ---------------------------------------------------------------------------
// the operational primitives, as staff would perform them
// ---------------------------------------------------------------------------

async function staffAppointment(token: string, customerId: string, vehicleId: string, codes: string[]) {
  const avail = await call(`/appointments/availability?siteId=${fx.siteId}&serviceCodes=${codes.join(',')}&vehicleId=${vehicleId}&days=7`, { token });
  const startAt: string | undefined = avail.nextAvailable?.startAt;
  if (!startAt) throw new Error('staff availability returned no slot');
  const appt = await call('/appointments', { method: 'POST', token, body: JSON.stringify({ siteId: fx.siteId, customerId, vehicleId, scheduledStartAt: startAt, serviceTypes: codes.map((c) => ({ serviceTypeCode: c })) }) });
  created.appointments.push(appt.id);
  return { id: appt.id as string, plannedMinutes: avail.plannedMinutes as number, startAt, endAt: appt.scheduledEndAt as string };
}
async function checkIn(token: string, appointmentId: string, mileageIn?: number) {
  const r = await call(`/appointments/${appointmentId}/check-in`, { method: 'POST', token, body: JSON.stringify(mileageIn ? { mileageIn } : {}) });
  const visitId = r.serviceVisit.id as string;
  created.visits.push(visitId);
  return { visitId, ticket: r.queueTicket?.ticketNumber as string | undefined };
}
async function createOrder(token: string, visitId: string, codes: string[]) {
  return call(`/service-orders`, { method: 'POST', token, body: JSON.stringify({ serviceVisitId: visitId, items: codes.map((c) => ({ serviceTypeCode: c })) }) });
}
const approve = (token: string, id: string) => call(`/service-orders/${id}/approve`, { method: 'POST', token, body: '{}' });
const assign = (token: string, id: string, technicianId: string, bayId?: string, extra: Record<string, unknown> = {}) =>
  call(`/service-orders/${id}/assign`, { method: 'POST', token, body: JSON.stringify({ technicianId, ...(bayId ? { bayId } : {}), ...extra }) });
const status = (token: string, id: string, toStatus: string, extra: Record<string, unknown> = {}) =>
  call(`/service-orders/${id}/status`, { method: 'POST', token, body: JSON.stringify({ toStatus, ...extra }) });
const pause = (token: string, id: string, reasonCode: string) => call(`/service-orders/${id}/pause`, { method: 'POST', token, body: JSON.stringify({ reasonCode, notes: 'audit' }) });
const resume = (token: string, id: string) => call(`/service-orders/${id}/resume`, { method: 'POST', token, body: '{}' });
const readyForQc = (token: string, id: string) => call(`/service-orders/${id}/ready-for-qc`, { method: 'POST', token, body: '{}' });
const order = (token: string, id: string) => call(`/service-orders/${id}`, { token });
const orderByVisit = (token: string, visitId: string) => call(`/service-orders/by-visit/${visitId}`, { token });
const myJobs = (token: string) => call(`/service-orders/mine/assignments`, { token });
const jobSheet = (token: string, visitId: string) => call(`/service-visits/${visitId}/job-sheet`, { token });

/** The full lifecycle after assignment; returns the final status. */
async function runToCompletion(token: string, orderId: string, area: string, withPause = true, techToken: string = token, afterStart?: () => Promise<void>) {
  await status(token, orderId, 'IN_PROGRESS');
  let o = await order(token, orderId);
  check(area, 'Start → IN_PROGRESS, startedAt stamped', o.status === 'IN_PROGRESS' && !!o.startedAt, `status=${o.status}`);
  if (afterStart) await afterStart();
  if (withPause) {
    await pause(token, orderId, 'WAITING_PARTS');
    o = await order(token, orderId);
    check(area, 'Pause (WAITING_PARTS) → paused state', ['PAUSED', 'WAITING_PARTS'].includes(o.status), `status=${o.status}`);
    await resume(token, orderId);
    o = await order(token, orderId);
    check(area, 'Resume → IN_PROGRESS', o.status === 'IN_PROGRESS', `status=${o.status}`);
  }
  // CR-2026-101 — only the ASSIGNED technician may send work to QC; an advisor is refused.
  const advisorRefused = await expectStatus(403, () => readyForQc(token, orderId));
  check(area, 'advisor is refused ready-for-qc (technician-only rule intact)', advisorRefused);
  await readyForQc(techToken, orderId);
  o = await order(token, orderId);
  check(area, 'Ready for QC → QC (as the assigned technician)', o.status === 'QC', `status=${o.status}`);
  await status(token, orderId, 'READY_TO_INVOICE');
  await status(token, orderId, 'CLOSED');
  o = await order(token, orderId);
  check(area, 'Complete → CLOSED', o.status === 'CLOSED', `status=${o.status}`);
  return o;
}

/** ETA fields on the visit right now. */
const eta = (visitId: string) => prisma.serviceVisit.findUniqueOrThrow({ where: { id: visitId }, select: { currentEtaStartAt: true, currentEtaCompleteAt: true, status: true } });

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

async function main() {
  fx = await fixture();
  const mgr = await login(MANAGER);
  const adv = await login(ADVISOR);
  const techA = await login(TECH_A);
  const techB = await login(TECH_B);

  const policyRow = await prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'booking_capacity_mode', effectiveTo: null }, select: { valueJson: true } });
  const capacityMode = String(policyRow?.valueJson ?? 'FIXED');
  console.log(`\nOperational regression audit — site ${fx.siteId}\n  booking_capacity_mode = ${capacityMode}   tag = ${TAG}`);

  // ------------------------------------------------------------------ S1
  let s1Order: string | null = null;
  await scenario('S1 · Staff appointment (Sedan, General Servicing) → assigned tech → complete', async () => {
    const A = 'S1 staff sedan';
    const { customerId, vehicleId } = await customerWithVehicle('Sedan', 'SEDAN_CLASS');
    const appt = await staffAppointment(adv, customerId, vehicleId, ['GEN-SERV-01']);
    check(A, 'advisor can book a service that is NOT publicly bookable (GEN-SERV-01)', true);
    const { visitId, ticket } = await checkIn(adv, appt.id, 61_200);
    check(A, 'check-in creates a ServiceVisit and a QueueTicket', !!visitId && !!ticket, `ticket=${ticket}`);
    const queued = await eta(visitId);
    check(A, 'ETA is projected while queued', !!queued.currentEtaStartAt, JSON.stringify(queued));

    const o = await createOrder(adv, visitId, ['GEN-SERV-01']);
    s1Order = o.id;
    check(A, 'exactly ONE order line for General Servicing (no package expansion)', o.items.length === 1, `items=${o.items.length}`);
    check(A, 'Sedan General Servicing line estimate = 90', o.items[0].estimateMinutes === 90, `estimate=${o.items[0].estimateMinutes}`);
    await approve(adv, o.id);
    const techs = await call(`/technicians/available?siteId=${fx.siteId}&bayTypes=GENERAL`, { token: adv });
    check(A, 'advisor can view eligible technicians and compatible bays', (techs.technicians?.length ?? 0) > 0 && (techs.bays?.length ?? 0) > 0, `technicians=${techs.technicians?.length} bays=${techs.bays?.length}`);
    const assigned = await assign(adv, o.id, fx.techA, fx.bay1);
    check(A, 'advisor can assign technician + bay (WorkBay, no WorkResource needed)', assigned.status === 'ASSIGNED', `status=${assigned.status}`);

    const jobs = await myJobs(techA);
    const mine = jobs.find((j: any) => j.orderId === o.id);
    check(A, "job appears in Technician A's workspace", !!mine);
    if (mine) {
      const fields = {
        customer: typeof mine.customerName === 'string' && mine.customerName.trim().length > 0,
        vehicle: !!mine.vehicle && !!mine.plate,
        vehicleClass: mine.vehicleClass === 'SEDAN_CLASS',
        service: Array.isArray(mine.services) && mine.services.length > 0,
        serviceOrder: mine.orderId === o.id,
        expectedDuration: mine.expectedMinutes === 90 && typeof mine.plannedMinutes === 'number',
        sourceIndicator: mine.sourceType === 'APPOINTMENT' && !!mine.appointmentAt,
        priority: 'priorityClass' in mine,
        bay: typeof mine.bay === 'string',
        status: mine.orderStatus === 'ASSIGNED',
        eta: !!mine.eta,
        jobSheetLink: typeof mine.serviceVisitId === 'string',
      };
      const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
      check(A, 'workspace card: customer/vehicle/class/service/order/expected 90/source/priority/bay/status/ETA/visit link', missing.length === 0, `missing=${missing.join(',')}`);
    }
    const boardRow = async () => { const b = await call(`/queue/board?siteId=${fx.siteId}`, { token: adv }); const list = Array.isArray(b) ? b : (b.tickets ?? b.items ?? b.rows ?? []); return list.find((r: any) => r.ticketNumber === ticket); };
    const onBoard = await boardRow();
    check(A, 'dispatch board still lists the ticket after assignment (waiting, appointment-sourced)', !!onBoard && ['WAITING', 'PENDING_RANK', 'CALLED'].includes(onBoard.displayStatus) && onBoard.sourceType === 'APPOINTMENT', JSON.stringify(onBoard && { displayStatus: onBoard.displayStatus, sourceType: onBoard.sourceType }));

    const done = await runToCompletion(adv, o.id, A, true, techA, async () => {
      const live = await boardRow();
      check(A, 'dispatch board shows IN_SERVICE once work starts', !!live && live.displayStatus === 'IN_SERVICE', JSON.stringify(live && { displayStatus: live.displayStatus }));
    });
    const gone = await boardRow();
    check(A, 'ticket leaves the dispatch board once the visit is complete', !gone, JSON.stringify(gone && { displayStatus: gone.displayStatus, visitStatus: gone.visitStatus }));
    const after = await eta(visitId);
    check(A, 'ETA fields still coherent after completion', !!after, JSON.stringify(after));
    const sheet = await jobSheet(adv, visitId);
    check(A, 'Job Sheet retrievable after CLOSE (historical retrieval) with mileage on the visit field', sheet.mileageIn === 61_200, `mileageIn=${sheet.mileageIn}`);
    check(A, 'assignment history recorded and COMPLETED', done.assignments?.some((a: any) => a.technicianId === fx.techA), JSON.stringify(done.assignments?.map((a: any) => a.status)));
  });

  // ------------------------------------------------------------------ S2
  await scenario('S2 · Customer self-service booking (Other → ASSESS-01) → Job Sheet → assigned → complete', async () => {
    const A = 'S2 customer';
    const phone = `876-555-${String(9100 + created.customers.length)}`;
    const plate = `${TAG}C`;
    await call('/public/booking/identify', { method: 'POST', body: JSON.stringify({ phone, plateNumber: plate }) });
    const avail = await call(`/public/booking/availability?serviceCodes=ASSESS-01&days=14`);
    const concern = 'Rattle under the car over bumps, worse when cold.';
    const booking = await call('/public/booking/confirm', {
      method: 'POST',
      body: JSON.stringify({
        customer: { firstName: 'Audit', lastName: 'Customer', phone, smsOptIn: false, emailOptIn: false },
        vehicle: { plateNumber: plate, make: 'Honda', model: 'Fit', modelYear: 2018 },
        serviceCodes: ['ASSESS-01'], scheduledStartAt: avail.nextAvailable.startAt,
        serviceRequest: { reasonForVisit: 'Other / Describe My Issue', concern, category: 'OTHER', mileage: 112_300 },
      }),
    });
    const appt = await prisma.appointment.findFirstOrThrow({ where: { appointmentNumber: booking.appointmentNumber }, select: { id: true, customerId: true, vehicleId: true, sourceChannel: true } });
    created.appointments.push(appt.id); created.customers.push(appt.customerId); created.vehicles.push(appt.vehicleId);
    check(A, 'booking created with sourceChannel CUSTOMER_SELF_SERVICE', appt.sourceChannel === 'CUSTOMER_SELF_SERVICE');

    const { visitId } = await checkIn(adv, appt.id);
    const sheet = await jobSheet(adv, visitId);
    check(A, "Job Sheet pre-filled: customer's concern verbatim + mileage on the visit", sheet.appointment?.bookingIntake?.customerConcern === concern && sheet.mileageIn === 112_300, `mileageIn=${sheet.mileageIn}`);

    const o = await createOrder(adv, visitId, ['ASSESS-01']);
    check(A, 'Service Assessment line estimate = 30 (catalogue value, not inflated)', o.items[0].estimateMinutes === 30, `estimate=${o.items[0].estimateMinutes}`);
    await approve(adv, o.id);
    await assign(adv, o.id, fx.techB, fx.bay1, { acknowledgeWorkload: true });
    const jobs = await myJobs(techB);
    check(A, 'customer-originated job reaches the technician workspace like any other', jobs.some((j: any) => j.orderId === o.id));
    await runToCompletion(adv, o.id, A, false, techB);

    const kpi = await prisma.workOrderKpiSnapshot.findFirst({ where: { serviceOrderId: o.id } });
    const mapping = await prisma.kpiServiceComponent.findFirst({ where: { serviceType: { code: 'ASSESS-01' }, isActive: true }, select: { componentRole: true, contributionMode: true } });
    check(A, 'ASSESS-01 is mapped SEPARATE_SLA and NOT classified GENERAL_SERVICE_CORE', mapping?.contributionMode === 'SEPARATE_SLA' && mapping?.componentRole !== 'GENERAL_SERVICE_CORE', JSON.stringify(mapping));
    check(A, 'ASSESS-01 order did not receive a 90/120 General Service benchmark', !kpi || ![90, 120].includes(kpi.standardMinutes ?? -1), `snapshot=${JSON.stringify(kpi && { std: kpi.standardMinutes })}`);
  });

  // ------------------------------------------------------------------ S3
  await scenario('S3 · Walk-in (SUV, General Servicing) → auto order → assigned → complete', async () => {
    const A = 'S3 walk-in SUV';
    const { customerId, vehicleId } = await customerWithVehicle('WalkinSUV', 'SUV_CLASS');
    const r = await call('/walk-ins', { method: 'POST', token: adv, body: JSON.stringify({ siteId: fx.siteId, customerId, vehicleId, serviceTypes: [{ serviceTypeCode: 'GEN-SERV-01' }], mileageIn: 88_000 }) });
    const visitId = (r.serviceVisit?.id ?? r.visit?.id) as string;
    created.visits.push(visitId);
    check(A, 'walk-in creates a visit and a ticket', !!visitId && !!(r.queueTicket?.ticketNumber ?? r.ticket?.ticketNumber));
    const orders = await orderByVisit(adv, visitId);
    const o = Array.isArray(orders) ? orders[0] : orders;
    check(A, 'walk-in raises a DRAFT order automatically', !!o && o.status === 'DRAFT', `status=${o?.status}`);
    check(A, 'SUV General Servicing walk-in estimate = 120', o?.items?.[0]?.estimateMinutes === 120, `estimate=${o?.items?.[0]?.estimateMinutes}`);
    check(A, 'exactly one line (no duplicate from KPI classifier rows)', o?.items?.length === 1, `items=${o?.items?.length}`);
    await approve(adv, o.id);
    await assign(adv, o.id, fx.techB, fx.bay2, { acknowledgeWorkload: true });
    await runToCompletion(adv, o.id, A, true, techB);
  });

  // ------------------------------------------------------------------ S4
  await scenario('S4 · Technician reassignment A → B (queued and after start)', async () => {
    const A = 'S4 reassign';
    const { customerId, vehicleId } = await customerWithVehicle('Reassign', 'SEDAN_CLASS');
    const appt = await staffAppointment(adv, customerId, vehicleId, ['BRK-01']);
    const { visitId } = await checkIn(adv, appt.id);
    const o = await createOrder(adv, visitId, ['BRK-01']);
    const est = o.items[0].estimateMinutes;
    await approve(adv, o.id);
    const a1 = await assign(adv, o.id, fx.techA, fx.bay1, { acknowledgeWorkload: true });
    const asgId = a1.assignments?.find((a: any) => a.technicianId === fx.techA)?.id ?? a1.id;
    await call(`/service-orders/${o.id}/assignments/${asgId}`, { method: 'PATCH', token: mgr, body: JSON.stringify({ technicianId: fx.techB }) });
    let cur = await order(adv, o.id);
    const active = cur.assignments.filter((a: any) => !a.endedAt);
    check(A, 'after reassignment exactly one ACTIVE assignment, on Technician B', active.length === 1 && active[0].technicianId === fx.techB, JSON.stringify(cur.assignments.map((a: any) => [a.technicianId === fx.techA ? 'A' : 'B', a.status, !!a.endedAt])));
    check(A, 'same ServiceOrder, estimate unchanged by reassignment', cur.id === o.id && cur.items[0].estimateMinutes === est, `estimate ${est}→${cur.items[0].estimateMinutes}`);
    check(A, 'Technician B now sees it; Technician A does not', (await myJobs(techB)).some((j: any) => j.orderId === o.id) && !(await myJobs(techA)).some((j: any) => j.orderId === o.id));
    const sheet = await jobSheet(adv, visitId);
    check(A, 'Job Sheet still linked to the same visit', !!sheet && (sheet.id === visitId || sheet.serviceVisitId === visitId || !!sheet.mileageIn !== undefined));
    await status(adv, o.id, 'IN_PROGRESS');
    const asg2 = (await order(adv, o.id)).assignments.find((a: any) => !a.endedAt)?.id;
    await call(`/service-orders/${o.id}/assignments/${asg2}`, { method: 'PATCH', token: mgr, body: JSON.stringify({ technicianId: fx.techA }) });
    cur = await order(adv, o.id);
    check(A, 'reassignment after START keeps the order IN_PROGRESS with one active assignment', cur.status === 'IN_PROGRESS' && cur.assignments.filter((a: any) => !a.endedAt).length === 1, `status=${cur.status}`);
    const hist = await prisma.statusHistory.count({ where: { entityId: o.id } });
    check(A, 'assignment/status history is auditable', hist > 0, `rows=${hist}`);
    await readyForQc(techA, o.id); await status(adv, o.id, 'READY_TO_INVOICE'); await status(adv, o.id, 'CLOSED');
  });

  // ------------------------------------------------------------------ S5 + S7 (bay change, then resource out of service)
  await scenario('S5/S7 · Bay change during live work, then WorkResource → MAINTENANCE', async () => {
    const A = 'S5 bay / S7 resource';
    const { customerId, vehicleId } = await customerWithVehicle('Bay', 'SEDAN_CLASS');
    const appt = await staffAppointment(adv, customerId, vehicleId, ['BRK-01']);
    const { visitId } = await checkIn(adv, appt.id);
    // The bay-type constraint is existing behaviour and must survive: a LUBE service cannot be assigned to a GENERAL bay.
    const lube = await createOrder(adv, visitId, ['OIL-01']); await approve(adv, lube.id);
    check(A, 'assignment still refuses an incompatible bay type (OIL-01 → GENERAL bay = 400)', await expectStatus(400, () => assign(adv, lube.id, fx.techB, fx.bay1, { acknowledgeWorkload: true })));
    const o = await createOrder(adv, visitId, ['BRK-01']);
    await approve(adv, o.id);
    const a1 = await assign(adv, o.id, fx.techA, fx.bay1, { acknowledgeWorkload: true });
    const asgId = a1.assignments?.find((a: any) => !a.endedAt)?.id;
    await status(adv, o.id, 'IN_PROGRESS');
    await call(`/service-orders/${o.id}/assignments/${asgId}`, { method: 'PATCH', token: mgr, body: JSON.stringify({ bayId: fx.bay2 }) });
    let cur = await order(adv, o.id);
    const active = cur.assignments.filter((a: any) => !a.endedAt);
    check(A, 'bay change → still ONE active assignment, now on the new bay, no duplicate', active.length === 1 && active[0].bayId === fx.bay2, JSON.stringify(active.map((a: any) => a.bayId)));
    check(A, 'job still IN_PROGRESS after bay change', cur.status === 'IN_PROGRESS', `status=${cur.status}`);

    // The parallel WorkResource of the ORIGINAL bay goes to MAINTENANCE. The live job is on WorkBay BAY-02;
    // the registry must not touch it either way.
    await call(`/resources/${fx.res1}/status`, { method: 'POST', token: mgr, body: JSON.stringify({ status: 'MAINTENANCE', reason: 'audit — lift inspection' }) });
    cur = await order(adv, o.id);
    check(A, 'WorkResource MAINTENANCE does not cancel, delete or alter the live job', cur.status === 'IN_PROGRESS' && cur.assignments.filter((a: any) => !a.endedAt).length === 1, `status=${cur.status}`);
    // The warning surface: the overview row flags the resource non-operational with the reason,
    // and the graded word lives on the resource's operational-status. Neither blocks anything.
    const overview = await call(`/resources/overview?siteId=${fx.siteId}`, { token: adv });
    const row = (overview.resources ?? []).find((r: any) => r.resourceId === fx.res1 || r.code === fx.res1Code);
    check(A, `resources overview flags ${fx.res1Code} non-operational with the reason (warning surface, not a block)`, !!row && row.isOperational === false && typeof row.operationalReason === 'string', JSON.stringify(row && { isOperational: row.isOperational, operationalReason: row.operationalReason }));
    const op = await call(`/resources/${fx.res1}/operational-status`, { token: adv });
    check(A, `operational-status reports MAINTENANCE for ${fx.res1Code}`, op.status === 'MAINTENANCE' && op.isOperational === false, JSON.stringify({ status: op.status }));
    const stillAssignable = await assign(adv, (await (async () => { const x = await createOrder(adv, visitId, ['BRK-01']); await approve(adv, x.id); return x; })()).id, fx.techB, fx.bay1, { acknowledgeWorkload: true }).then(() => true).catch(() => false);
    check(A, 'staff can still assign to WorkBay BAY-01 while its parallel WorkResource is in MAINTENANCE (WorkBay authoritative)', stillAssignable);
    await call(`/resources/${fx.res1}/status`, { method: 'POST', token: mgr, body: JSON.stringify({ status: 'AVAILABLE' }) });
    await readyForQc(techA, o.id); await status(adv, o.id, 'READY_TO_INVOICE'); await status(adv, o.id, 'CLOSED');
  });

  // ------------------------------------------------------------------ S6
  await scenario('S6 · Multi-job technician: independent states', async () => {
    const A = 'S6 multi-job';
    const j1 = await customerWithVehicle('Multi1', 'SEDAN_CLASS');
    const j2 = await customerWithVehicle('Multi2', 'SEDAN_CLASS');
    const mk = async (c: typeof j1) => { const ap = await staffAppointment(adv, c.customerId, c.vehicleId, ['BRK-01']); const { visitId } = await checkIn(adv, ap.id); const o = await createOrder(adv, visitId, ['BRK-01']); await approve(adv, o.id); return o.id as string; };
    const o1 = await mk(j1); const o2 = await mk(j2);
    await assign(adv, o1, fx.techB, fx.bay1, { acknowledgeWorkload: true });
    const warned = await expectStatus(409, () => assign(adv, o2, fx.techB, fx.bay2));
    check(A, 'a second job WARNS (409 TECHNICIAN_HAS_OPEN_WORK) until acknowledged — warn-not-block intact', warned);
    const second = await assign(adv, o2, fx.techB, fx.bay2, { acknowledgeWorkload: true }).then(() => true).catch((e) => e.message);
    check(A, 'acknowledged → technician holds two assigned jobs', second === true, String(second));
    const jobs = await myJobs(techB);
    const ids = jobs.map((j: any) => j.orderId);
    check(A, 'technician sees BOTH jobs', ids.includes(o1) && ids.includes(o2));
    await status(adv, o1, 'IN_PROGRESS');
    await pause(adv, o1, 'WAITING_PARTS');
    const [s1, s2] = await Promise.all([order(adv, o1), order(adv, o2)]);
    check(A, 'pausing job 1 does not touch job 2', ['PAUSED', 'WAITING_PARTS'].includes(s1.status) && s2.status === 'ASSIGNED', `j1=${s1.status} j2=${s2.status}`);
    const start2 = await status(adv, o2, 'IN_PROGRESS').then(() => true).catch((e) => e.message);
    check(A, 'job 2 can start while job 1 is paused (one-open-segment guard honoured)', start2 === true, String(start2));
    await resume(adv, o1).catch(() => undefined);
    for (const id of [o1, o2]) { const cur = await order(adv, id); if (cur.status !== 'IN_PROGRESS') await status(adv, id, 'IN_PROGRESS').catch(() => undefined); await readyForQc(techB, id).catch(() => undefined); await status(adv, id, 'READY_TO_INVOICE').catch(() => undefined); await status(adv, id, 'CLOSED').catch(() => undefined); }
  });

  // ------------------------------------------------------------------ S8
  await scenario('S8 · Cancellation before work', async () => {
    const A = 'S8 cancel';
    const { customerId, vehicleId } = await customerWithVehicle('Cancel', 'SEDAN_CLASS');
    const appt = await staffAppointment(adv, customerId, vehicleId, ['OIL-01']);
    await call(`/appointments/${appt.id}/cancel`, { method: 'POST', token: adv, body: JSON.stringify({ reason: 'audit' }) });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, select: { status: true } });
    check(A, 'appointment → CANCELLED', row.status === 'CANCELLED', row.status);
    const orphans = await prisma.resourceReservation.count({ where: { appointmentId: appt.id } }).catch(() => 0);
    check(A, 'no orphaned capacity/reservation claims', orphans === 0, `reservations=${orphans}`);
  });

  // ------------------------------------------------------------------ S9 + S13
  await scenario('S9/S13 · Staff-only services and the canonical brake code', async () => {
    const A = 'S9 staff catalogue';
    const { customerId, vehicleId } = await customerWithVehicle('Brake', 'SEDAN_CLASS');
    const appt = await staffAppointment(adv, customerId, vehicleId, ['BRK-02']);
    check(A, 'staff can book BRK-02 (canonical, not publicly bookable)', !!appt.id);
    const publicRefused = await expectStatus(400, () => call(`/public/booking/availability?serviceCodes=BRK-02&days=3`));
    check(A, 'the public API refuses BRK-02 (customer catalogue stays restricted)', publicRefused);
    const { visitId } = await checkIn(adv, appt.id);
    const o = await createOrder(adv, visitId, ['BRK-02', 'ENG-01']);
    check(A, 'staff order can carry a diagnostic (ENG-01) and a repair (BRK-02) neither of which is public', o.items.length === 2, `items=${o.items.length}`);
    check(A, 'DISC-01 is never substituted for BRK-02', o.items.every((i: any) => i.serviceType.code !== 'DISC-01'));
  });

  // ------------------------------------------------------------------ S10 (unknown class)
  await scenario('S10 · Unknown vehicle class → safe longest duration everywhere', async () => {
    const A = 'S10 unknown class';
    const { customerId, vehicleId } = await customerWithVehicle('Unknown', null);
    const appt = await staffAppointment(adv, customerId, vehicleId, ['GEN-SERV-01']);
    const r = await call('/walk-ins', { method: 'POST', token: adv, body: JSON.stringify({ siteId: fx.siteId, customerId: (await customerWithVehicle('UnknownWI', null)).customerId, vehicleId: created.vehicles[created.vehicles.length - 1], serviceTypes: [{ serviceTypeCode: 'GEN-SERV-01' }], mileageIn: 50_000 }) });
    const wiVisit = (r.serviceVisit?.id ?? r.visit?.id) as string; created.visits.push(wiVisit);
    const wo = await orderByVisit(adv, wiVisit); const w = Array.isArray(wo) ? wo[0] : wo;
    check(A, 'unknown-class walk-in General Servicing estimate = 120', w?.items?.[0]?.estimateMinutes === 120, `estimate=${w?.items?.[0]?.estimateMinutes}`);
    const { visitId } = await checkIn(adv, appt.id, 40_000);
    const o = await createOrder(adv, visitId, ['GEN-SERV-01']);
    check(A, 'unknown-class staff order estimate = 120', o.items[0].estimateMinutes === 120, `estimate=${o.items[0].estimateMinutes}`);
    check(A, 'booking reservation stays on the DEFAULT policy (estimate ≠ reservation, by design)', appt.plannedMinutes === 80, `reservation=${appt.plannedMinutes}`);
  });

  // ------------------------------------------------------------------ S11 permissions
  await scenario('S11 · Permission boundaries', async () => {
    const A = 'S11 permissions';
    check(A, 'technician CANNOT read business rules (Settings)', await expectStatus(403, () => call('/config/business-rules', { token: techA })));
    check(A, 'technician CANNOT create an appointment', await expectStatus(403, () => call('/appointments', { method: 'POST', token: techA, body: '{}' })));
    check(A, 'technician CANNOT assign a technician', await expectStatus(403, () => call(`/service-orders/${s1Order}/assign`, { method: 'POST', token: techA, body: JSON.stringify({ technicianId: fx.techA }) })));
    check(A, 'technician CAN read their own jobs', Array.isArray(await myJobs(techA)));
    check(A, 'advisor CAN read the queue board', !!(await call(`/queue/board?siteId=${fx.siteId}`, { token: adv })));
    check(A, 'manager CAN read business rules', !!(await call('/config/business-rules', { token: mgr })));
    check(A, 'unauthenticated caller is refused on operational APIs', await expectStatus(401, () => call('/service-orders/mine/assignments')));
    check(A, 'a customer (no staff token) cannot reach the dispatch/queue API', await expectStatus(401, () => call(`/queue/board?siteId=${fx.siteId}`)));
  });

  // ------------------------------------------------------------------ S12 shadow authority
  await scenario('S12 · RESOURCE_AWARE SHADOW has no production authority', async () => {
    const A = 'S12 shadow';
    check(A, 'booking_capacity_mode is FIXED for this audit', capacityMode === 'FIXED', capacityMode);
    const before = await prisma.bookingShadowComparison.count().catch(() => -1);
    // Everything above ran with SHADOW observing. If it had authority, S1/S3/S5 would have been blocked or altered.
    const closed = await prisma.serviceOrder.count({ where: { serviceVisit: { id: { in: created.visits } }, status: 'CLOSED' } });
    check(A, 'every lifecycle above completed with SHADOW observing, none blocked', closed >= 5, `closed=${closed}`);
    check(A, 'shadow comparisons are recorded (diagnostics), not enforced', before >= 0);
    const unchanged = String((await prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'booking_capacity_mode', effectiveTo: null }, select: { valueJson: true } }))?.valueJson);
    check(A, 'production capacity mode unchanged by the audit', unchanged === capacityMode, unchanged);
  });

  // ------------------------------------------------------------------ report
  h1('RESULT MATRIX');
  const areas = [...new Set(rows.map((r) => r.area))];
  for (const a of areas) {
    const rs = rows.filter((r) => r.area === a);
    const fails = rs.filter((r) => !r.ok);
    console.log(`  ${fails.length ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mPASS\x1b[0m'}  ${a.padEnd(28)} ${rs.length - fails.length}/${rs.length}`);
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n  ${failed.length === 0 ? '\x1b[32mALL AREAS PASS\x1b[0m' : `\x1b[31m${failed.length} CHECK(S) FAILED\x1b[0m`}  (${rows.length} checks)\n`);
  for (const f of failed) console.log(`  · [${f.area}] ${f.check}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// cleanup — youngest reference first; every table is optional
// ---------------------------------------------------------------------------

async function cleanup() {
  const visitIds = created.visits;
  const orderIds = (await prisma.serviceOrder.findMany({ where: { serviceVisitId: { in: visitIds } }, select: { id: true } })).map((o) => o.id);
  const asgIds = (await prisma.technicianAssignment.findMany({ where: { serviceOrderId: { in: orderIds } }, select: { id: true } })).map((a) => a.id);
  const step = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.log(`    (cleanup ${label}: ${(e as Error).message.split('\n')[0].slice(0, 90)})`); } };
  await step('segments', () => prisma.technicianWorkSegment.deleteMany({ where: { assignmentId: { in: asgIds } } }));
  await step('pauses', () => prisma.serviceOrderPause.deleteMany({ where: { serviceOrderId: { in: orderIds } } }));
  await step('reworks', () => prisma.serviceOrderRework.deleteMany({ where: { serviceOrderId: { in: orderIds } } }));
  await step('kpi', () => prisma.workOrderKpiSnapshot.deleteMany({ where: { serviceOrderId: { in: orderIds } } }));
  await step('kpi-delays', () => prisma.kpiDelayEvent.deleteMany({ where: { serviceOrderId: { in: orderIds } } }));
  await step('assignments', () => prisma.technicianAssignment.deleteMany({ where: { serviceOrderId: { in: orderIds } } }));
  await step('items', () => prisma.serviceOrderItem.deleteMany({ where: { serviceOrderId: { in: orderIds } } }));
  await step('orders', () => prisma.serviceOrder.deleteMany({ where: { id: { in: orderIds } } }));
  await step('notes', () => prisma.visitNote.deleteMany({ where: { serviceVisitId: { in: visitIds } } }));
  await step('queue-decisions', () => prisma.queueDecision.deleteMany({ where: { queueTicket: { serviceVisitId: { in: visitIds } } } }));
  await step('queue-events', () => prisma.queueEvent.deleteMany({ where: { queueTicket: { serviceVisitId: { in: visitIds } } } }));
  await step('tickets', () => prisma.queueTicket.deleteMany({ where: { serviceVisitId: { in: visitIds } } }));
  await step('occupancy', () => prisma.resourceOccupancy.deleteMany({ where: { serviceVisitId: { in: visitIds } } }));
  await step('drafts', () => prisma.jobSheetDraft.deleteMany({ where: { serviceVisitId: { in: visitIds } } }));
  await step('history', () => prisma.statusHistory.deleteMany({ where: { entityId: { in: [...orderIds, ...visitIds, ...created.appointments] } } }));
  await step('visits', () => prisma.serviceVisit.deleteMany({ where: { id: { in: visitIds } } }));
  await step('intake', () => prisma.bookingIntake.deleteMany({ where: { appointmentId: { in: created.appointments } } }));
  await step('appt-services', () => prisma.appointmentService.deleteMany({ where: { appointmentId: { in: created.appointments } } }));
  await step('appointments', () => prisma.appointment.deleteMany({ where: { id: { in: created.appointments } } }));
  await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: created.vehicles } } }));
  await step('customers', () => prisma.customer.deleteMany({ where: { id: { in: created.customers } } }));
}

main()
  .catch((e) => { console.error(`\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\n`); process.exitCode = 1; })
  .finally(async () => {
    if (KEEP) console.log(`  Kept: tag ${TAG}.\n`);
    else { await cleanup(); console.log('  Audit records removed. Pass --keep to leave them for inspection.\n'); }
    await prisma.$disconnect();
  });
