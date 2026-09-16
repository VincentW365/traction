/**
 * CR-2026-108 Stage 1 — is this message about a TEST record?
 *
 * The problem this solves: UAT of customer self-service booking has to run against
 * a production-like environment, and every booking sends a confirmation. Without
 * this, a tester walking the /book flow emails or texts whoever the test record
 * happens to resemble — or, with the legacy global TEST mode, EVERY genuine
 * customer message gets redirected to one mailbox, which is worse: a real
 * customer silently stops being told their car is ready.
 *
 * So suppression is decided PER RECORD, not per environment. A notification is
 * captured (recorded in full, never transmitted) only when the thing it is about
 * belongs to a test run. Everything else delivers exactly as before.
 *
 * The test anchors already exist in the schema: `testDataRunId` on Customer,
 * Vehicle and ServiceVisit (see TestDataRun). Appointment carries no anchor of
 * its own, so an appointment is resolved through its customer / vehicle / visit —
 * which is exactly how a self-service booking made for a test customer is caught.
 *
 * THREE outcomes, not two (CR-2026-108 hardening §3). "I could not tell" is not
 * the same as "this is a genuine customer": the first must be visible to whoever
 * runs this deployment, because it means the safety net was not actually checked.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export type TestRecordVia = 'CUSTOMER' | 'VEHICLE' | 'SERVICE_VISIT' | 'APPOINTMENT' | 'EXPLICIT_CONTEXT';

/**
 * TEST     — provably belongs to a test run; capture it.
 * GENUINE  — positively determined to be a real customer record; deliver it.
 * UNKNOWN  — the lookup failed. Delivered (see below) but never recorded as if
 *            it had been positively classified.
 */
export type TestClassification = 'TEST' | 'GENUINE' | 'UNKNOWN';

export interface TestRecordVerdict {
  /** True only for TEST. UNKNOWN is deliberately false — it delivers. */
  isTest: boolean;
  classification: TestClassification;
  /** Which anchor proved it (for the capture log and the UAT view). */
  via: TestRecordVia | null;
  /** The run's human label, e.g. "uat-booking-2026-09-16". */
  runLabel: string | null;
  /** Populated only for UNKNOWN: why the classification could not be made. */
  failureReason?: string;
}

const GENUINE: TestRecordVerdict = { isTest: false, classification: 'GENUINE', via: null, runLabel: null };

/**
 * Explicit test context travelling WITH the request, rather than rediscovered
 * from related rows. When present it wins outright — including over a database
 * lookup that failed — because the caller already knows this is a test.
 */
export interface ExplicitTestContext {
  testDataRunId?: string | null;
  runLabel?: string | null;
}

export interface TestRecordSubject {
  entityType?: string;
  entityId?: string;
  customerId?: string | null;
  vehicleId?: string | null;
  /** CR-2026-108 §3 — takes precedence over any lookup, successful or not. */
  testContext?: ExplicitTestContext | null;
}

@Injectable()
export class TestRecordResolver {
  private readonly logger = new Logger('TestRecords');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve whether a pending notification is about a test record.
   *
   * On an internal error the verdict is UNKNOWN, which still DELIVERS: wrongly
   * capturing a genuine message silently denies a real customer information about
   * their vehicle, and a test message that escapes is visible and recoverable.
   * The caller is responsible for making UNKNOWN observable — it must never be
   * quietly treated as a clean "genuine" classification.
   */
  async resolve(subject: TestRecordSubject): Promise<TestRecordVerdict> {
    // 0. Explicit context wins, and is not subject to the database being healthy.
    const explicit = subject.testContext;
    if (explicit?.testDataRunId || explicit?.runLabel) {
      return {
        isTest: true,
        classification: 'TEST',
        via: 'EXPLICIT_CONTEXT',
        runLabel: explicit.runLabel ?? explicit.testDataRunId ?? null,
      };
    }

    try {
      // 1. The direct links the notification already carries.
      if (subject.customerId) {
        const c = await this.prisma.customer.findUnique({
          where: { id: subject.customerId },
          select: { testDataRun: { select: { label: true } } },
        });
        if (c?.testDataRun) return { isTest: true, classification: 'TEST', via: 'CUSTOMER', runLabel: c.testDataRun.label };
      }
      if (subject.vehicleId) {
        const v = await this.prisma.vehicle.findUnique({
          where: { id: subject.vehicleId },
          select: { testDataRun: { select: { label: true } } },
        });
        if (v?.testDataRun) return { isTest: true, classification: 'TEST', via: 'VEHICLE', runLabel: v.testDataRun.label };
      }

      // 2. The entity the message is about, when it is one that carries an anchor
      //    or can reach one. An Appointment has no anchor of its own.
      if (subject.entityId && subject.entityType === 'ServiceVisit') {
        const sv = await this.prisma.serviceVisit.findUnique({
          where: { id: subject.entityId },
          select: { testDataRun: { select: { label: true } } },
        });
        if (sv?.testDataRun) return { isTest: true, classification: 'TEST', via: 'SERVICE_VISIT', runLabel: sv.testDataRun.label };
      }
      if (subject.entityId && subject.entityType === 'Appointment') {
        const appt = await this.prisma.appointment.findUnique({
          where: { id: subject.entityId },
          select: {
            customer: { select: { testDataRun: { select: { label: true } } } },
            vehicle: { select: { testDataRun: { select: { label: true } } } },
            serviceVisit: { select: { testDataRun: { select: { label: true } } } },
          },
        });
        const label =
          appt?.customer?.testDataRun?.label ??
          appt?.vehicle?.testDataRun?.label ??
          appt?.serviceVisit?.testDataRun?.label ??
          null;
        if (label) return { isTest: true, classification: 'TEST', via: 'APPOINTMENT', runLabel: label };
      }

      return GENUINE;
    } catch (e: unknown) {
      const failureReason = e instanceof Error ? e.message : String(e);
      // Structured, greppable, and carrying the identifiers needed to find the
      // record afterwards. The caller additionally writes an audit row.
      this.logger.error(
        `TEST_CLASSIFICATION_UNAVAILABLE entityType=${subject.entityType ?? '-'} entityId=${subject.entityId ?? '-'} ` +
          `customerId=${subject.customerId ?? '-'} vehicleId=${subject.vehicleId ?? '-'} reason="${failureReason}" ` +
          '— delivering as a real customer message; classification was NOT established.',
      );
      return { isTest: false, classification: 'UNKNOWN', via: null, runLabel: null, failureReason };
    }
  }
}
