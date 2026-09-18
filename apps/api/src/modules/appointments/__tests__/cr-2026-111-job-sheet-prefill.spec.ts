import { describe, it, expect, vi } from 'vitest';
import { CheckInService, readableSymptom } from '../check-in.service';

/**
 * CR-2026-111 §17 — the customer enters it once, and the Job Sheet already has it.
 *
 * This is the half of the journey after the booking: the vehicle arrives, an
 * advisor checks it in, and what the customer typed online has to be on the Job
 * Sheet without anyone retyping it. Two specific breaks are covered, because both
 * were real:
 *
 *  - the concern lived only in a note the Job Sheet did not read;
 *  - the mileage lived on `Appointment.customerReportedMileage` while the Job Sheet
 *    reads `ServiceVisit.mileageIn`, and nothing joined the two.
 *
 * The booking half — what the customer's choices actually book — is proved in
 * `public-booking/__tests__/cr-2026-111-intake.spec.ts`.
 */

const NOW = new Date('2026-09-18T14:00:00Z');

interface Opts {
  sourceChannel?: string;
  notes?: string | null;
  customerReportedMileage?: number | null;
  intake?: { category: string; customerConcern: string | null; symptoms: string[]; additionalComments: string | null } | null;
  /** A reading the advisor took at the desk, which must always win. */
  staffMileageIn?: number | null;
  requiresMileage?: boolean;
}

function build(o: Opts = {}) {
  const appointment = {
    id: 'appt-1',
    status: 'CONFIRMED',
    serviceVisit: null,
    customerId: 'c1',
    vehicleId: 'v1',
    siteId: 's1',
    sourceChannel: o.sourceChannel ?? 'CUSTOMER_SELF_SERVICE',
    notes: o.notes ?? null,
    customerReportedMileage: o.customerReportedMileage ?? null,
    services: [{ serviceType: { requiresMileage: o.requiresMileage ?? false } }],
    customer: { notificationOptInSms: true, notificationOptInEmail: false },
    vehicle: { serviceClass: 'SEDAN_CLASS', weightClass: null },
    site: { code: 'BERT-01', timezone: 'America/Jamaica' },
  };

  const visitNotes: Array<Record<string, unknown>> = [];
  let visitMileageIn: number | null = o.staffMileageIn ?? null;

  const tx: any = {
    serviceVisit: {
      create: vi.fn(async ({ data }: any) => ({
        id: 'sv-1',
        ...data,
        mileageIn: visitMileageIn,
        customer: { id: 'c1', firstName: 'Jane', lastName: 'Doe', phone: '876-555-0100' },
        vehicle: { id: 'v1', plateNumber: 'ABC1234', make: 'Toyota', model: 'Corolla', modelYear: 2019 },
      })),
      update: vi.fn(async ({ data }: any) => {
        if (typeof data.mileageIn === 'number') visitMileageIn = data.mileageIn;
        return { id: 'sv-1', ...data };
      }),
    },
    bookingIntake: { findUnique: vi.fn(async () => o.intake ?? null) },
    visitNote: { create: vi.fn(async ({ data }: any) => { visitNotes.push(data); return data; }) },
    queueTicket: { create: vi.fn(async ({ data }: any) => ({ id: 'qt-1', ticketNumber: 'A001', ...data })) },
    appointment: { update: vi.fn(async ({ data }: any) => data) },
    vehicle: { update: vi.fn(async () => ({})) },
    vehicleClassification: { upsert: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [{ next_val: 1 }]),
    $executeRaw: vi.fn(async () => 1),
  };

  const prisma: any = {
    appointment: { findUnique: vi.fn(async () => appointment) },
    serviceVisit: { findFirst: vi.fn(async () => null) },
    customer: { update: vi.fn(async () => ({})) },
    businessRuleConfig: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    queueTicket: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new CheckInService(prisma as any, statusHistory as any, audit as any);
  return { service, prisma, tx, visitNotes, mileage: () => visitMileageIn };
}

/** Run a check-in, tolerating anything after the block under test. */
async function checkIn(h: ReturnType<typeof build>, intake?: Record<string, unknown>) {
  try {
    await h.service.checkIn('appt-1', 'user-1', undefined, intake as any);
  } catch {
    /* later stages (queue ranking, ETA) are out of scope for these assertions */
  }
}

const concernNotes = (h: ReturnType<typeof build>) =>
  h.visitNotes.filter((n) => n.kind === 'CUSTOMER_CONCERN').map((n) => String(n.text));

// ---------------------------------------------------------------------------

describe("§6 the customer's concern reaches the visit", () => {
  it("leads with the customer's own sentence", async () => {
    const h = build({
      intake: { category: 'BRAKES', customerConcern: 'Grinding noise when I brake going downhill.', symptoms: [], additionalComments: null },
    });
    await checkIn(h);
    expect(concernNotes(h)[0]).toBe('From the online booking: Grinding noise when I brake going downhill.');
  });

  it('translates ticked symptom codes into plain words, never raw codes', async () => {
    const h = build({
      intake: {
        category: 'BRAKES',
        customerConcern: 'It squeals at low speed.',
        symptoms: ['BRAKE_NOISE', 'BRAKE_VIBRATION'],
        additionalComments: 'Only when the car is cold.',
      },
    });
    await checkIn(h);
    const note = concernNotes(h)[0];
    expect(note).toContain('It squeals at low speed.');
    expect(note).toContain('brake noise');
    expect(note).toContain('brake vibration');
    expect(note).toContain('Only when the car is cold.');
    // An advisor reads this note. A raw enum in the middle of it is a leak of the
    // database's vocabulary into an operational document.
    expect(note).not.toContain('BRAKE_NOISE');
    expect(note).not.toMatch(/[A-Z]{3,}_[A-Z]/);
  });

  it('attributes it to the booking, not to a member of staff', async () => {
    const h = build({ intake: { category: 'OTHER', customerConcern: 'Something rattles.', symptoms: [], additionalComments: null } });
    await checkIn(h);
    const note = h.visitNotes.find((n) => n.kind === 'CUSTOMER_CONCERN')!;
    expect(note.authorRole).toBe('CUSTOMER_BOOKING');
    expect(note.text).toMatch(/^From the online booking: /);
    // A customer's description is not an alarm. Flagging every one would train
    // staff to ignore the flag.
    expect(note.requiresAttention).toBe(false);
  });

  /** Bookings taken before the structured intake existed still have to work. */
  it('falls back to the composed booking note for an older booking', async () => {
    const h = build({ intake: null, notes: '[Customer booking] Reason for visit: Brakes | Customer concern: squeal when braking' });
    await checkIn(h);
    expect(concernNotes(h)[0]).toBe('From the online booking: Reason for visit: Brakes | Customer concern: squeal when braking');
  });

  /**
   * A note that says "from the online booking" must only appear on a booking that
   * came from online. The provenance IS the point of the note.
   */
  it('writes nothing for a booking taken by staff at the desk', async () => {
    const h = build({ sourceChannel: 'STAFF', notes: 'Walk-in, wants a wash', customerReportedMileage: 40_000 });
    await checkIn(h);
    expect(concernNotes(h)).toHaveLength(0);
    expect(h.tx.serviceVisit.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { mileageIn: 40_000 } }));
  });

  it('writes nothing when the customer said nothing', async () => {
    const h = build({ intake: null, notes: null, customerReportedMileage: null });
    await checkIn(h);
    expect(concernNotes(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('§6 the mileage the customer typed reaches the Job Sheet', () => {
  it("promotes the customer's reading to the visit when the field is blank", async () => {
    const h = build({ customerReportedMileage: 84_500, intake: null });
    await checkIn(h);
    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(expect.objectContaining({ data: { mileageIn: 84_500 } }));
    expect(h.mileage()).toBe(84_500);
  });

  /**
   * A figure read off the dashboard at the desk is a measurement; a figure typed
   * into a phone days earlier is a recollection. This can promote the customer's
   * number into a blank, never overwrite one an advisor took.
   */
  it("never overwrites a reading an advisor took at the desk", async () => {
    const h = build({ customerReportedMileage: 84_500, staffMileageIn: 84_812 });
    await checkIn(h);
    const mileageUpdate = (h.tx.serviceVisit.update.mock.calls as any[]).find((c) => c[0]?.data?.mileageIn != null);
    expect(mileageUpdate).toBeUndefined();
    expect(h.mileage()).toBe(84_812);
  });

  it('says on the record that the number came from the customer, not the workshop', async () => {
    const h = build({ customerReportedMileage: 84_500, intake: null });
    await checkIn(h);
    const provenance = concernNotes(h).find((t) => t.includes('84,500') && t.includes('not a workshop measurement'));
    expect(provenance).toBeDefined();
  });

  it('does nothing when the customer gave no mileage', async () => {
    const h = build({ customerReportedMileage: null, intake: { category: 'OIL_CHANGE', customerConcern: 'Due for a service.', symptoms: [], additionalComments: null } });
    await checkIn(h);
    const mileageUpdate = (h.tx.serviceVisit.update.mock.calls as any[]).find((c) => c[0]?.data?.mileageIn != null);
    expect(mileageUpdate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('readableSymptom', () => {
  it('turns every code the booking page can send into plain words', () => {
    for (const code of [
      'BRAKE_NOISE', 'BRAKE_VIBRATION', 'BRAKE_WARNING_LIGHT', 'BRAKE_REDUCED_PERFORMANCE',
      'BATTERY_SLOW_START', 'BATTERY_REPEATEDLY_FLAT', 'BATTERY_WARNING_LIGHT', 'BATTERY_REPLACEMENT_REQUESTED',
      'ALIGN_PULLS_LEFT', 'ALIGN_PULLS_RIGHT', 'ALIGN_UNEVEN_TYRE_WEAR', 'ALIGN_WHEEL_OFF_CENTRE', 'ALIGN_VIBRATION',
      'NOT_SURE',
    ]) {
      const readable = readableSymptom(code);
      expect(readable, code).not.toBe(code);
      expect(readable, code).not.toMatch(/_/);
    }
  });

  it('degrades gracefully for a code it has never seen', () => {
    // A new symptom must not surface as SOME_NEW_CODE on a Job Sheet an advisor reads.
    expect(readableSymptom('SOME_NEW_CODE')).not.toContain('_');
  });
});
