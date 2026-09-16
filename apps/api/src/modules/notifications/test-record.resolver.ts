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
 * belongs to a test run. Everything else delivers exactly as it did before.
 *
 * The test anchors already exist in the schema: `testDataRunId` on Customer,
 * Vehicle and ServiceVisit (see TestDataRun). Appointment carries no anchor of
 * its own, so an appointment is resolved through its customer / vehicle / visit —
 * which is exactly how a self-service booking made for a test customer is caught.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export type TestRecordVia = 'CUSTOMER' | 'VEHICLE' | 'SERVICE_VISIT' | 'APPOINTMENT';

export interface TestRecordVerdict {
  /** True only when the subject of the message provably belongs to a test run. */
  isTest: boolean;
  /** Which anchor proved it (for the capture log and the UAT view). */
  via: TestRecordVia | null;
  /** The run's human label, e.g. "uat-booking-2026-09-16". */
  runLabel: string | null;
}

const NOT_TEST: TestRecordVerdict = { isTest: false, via: null, runLabel: null };

export interface TestRecordSubject {
  entityType?: string;
  entityId?: string;
  customerId?: string | null;
  vehicleId?: string | null;
}

@Injectable()
export class TestRecordResolver {
  private readonly logger = new Logger('TestRecords');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve whether a pending notification is about a test record.
   *
   * Fails CLOSED toward delivery: if the lookup itself errors we return "not a
   * test record", because wrongly capturing a genuine message silently denies a
   * real customer information about their vehicle. A test message that escapes is
   * visible and recoverable; a real message that never arrives is neither.
   */
  async resolve(subject: TestRecordSubject): Promise<TestRecordVerdict> {
    try {
      // 1. The direct links the notification already carries.
      if (subject.customerId) {
        const c = await this.prisma.customer.findUnique({
          where: { id: subject.customerId },
          select: { testDataRun: { select: { label: true } } },
        });
        if (c?.testDataRun) return { isTest: true, via: 'CUSTOMER', runLabel: c.testDataRun.label };
      }
      if (subject.vehicleId) {
        const v = await this.prisma.vehicle.findUnique({
          where: { id: subject.vehicleId },
          select: { testDataRun: { select: { label: true } } },
        });
        if (v?.testDataRun) return { isTest: true, via: 'VEHICLE', runLabel: v.testDataRun.label };
      }

      // 2. The entity the message is about, when it is one that carries an anchor
      //    or can reach one. An Appointment has no anchor of its own.
      if (subject.entityId && subject.entityType === 'ServiceVisit') {
        const sv = await this.prisma.serviceVisit.findUnique({
          where: { id: subject.entityId },
          select: { testDataRun: { select: { label: true } } },
        });
        if (sv?.testDataRun) return { isTest: true, via: 'SERVICE_VISIT', runLabel: sv.testDataRun.label };
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
        if (label) return { isTest: true, via: 'APPOINTMENT', runLabel: label };
      }

      return NOT_TEST;
    } catch (e: unknown) {
      this.logger.warn(
        `Could not determine whether a notification was about a test record (${subject.entityType ?? 'unknown'} ${subject.entityId ?? '-'}): ` +
          `${e instanceof Error ? e.message : String(e)} — treating it as a REAL customer message and delivering normally.`,
      );
      return NOT_TEST;
    }
  }
}
