import { Injectable, Logger } from '@nestjs/common';
import {
  CommunicationPreferenceSource,
  CommunicationPreferenceStatus,
  CommunicationPurpose,
  NotificationChannel,
} from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * CR-2026-114 — what the customer has actually told us, and how we know.
 *
 * One rule runs through this service: **the system records what is known, not
 * what would be convenient to assume.** A customer with no recorded answer is
 * UNKNOWN, and stays UNKNOWN until a person or the customer supplies one. It is
 * never quietly promoted to ALLOWED because we would like to email them, and
 * never demoted to DECLINED because a boolean once said false.
 *
 * The legacy `customers.notification_opt_in_email` column is kept in step here,
 * in the same transaction, as a documented PROJECTION for the screens and
 * serializers that still read it (CLAUDE.md §4 allows a projection; it does not
 * allow two independent truths). This service is the only writer of both.
 */
@Injectable()
export class CommunicationPreferenceService {
  private readonly logger = new Logger(CommunicationPreferenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The recorded status. Absence of a row IS the answer: UNKNOWN.
   *
   * Never throws: a preference lookup that fails must not take down a send
   * decision, and the safe direction is "we do not know", which gates optional
   * outreach rather than releasing it.
   */
  async statusFor(
    customerId: string,
    purpose: CommunicationPurpose,
    channel: NotificationChannel = 'EMAIL',
  ): Promise<CommunicationPreferenceStatus> {
    try {
      const row = await this.prisma.customerCommunicationPreference.findUnique({
        where: { customerId_channel_purpose: { customerId, channel, purpose } },
        select: { status: true },
      });
      return row?.status ?? 'UNKNOWN';
    } catch (error) {
      this.logger.warn(
        `Preference lookup failed for customer ${customerId} (${channel}/${purpose}); treating as UNKNOWN: ${(error as Error).message}`,
      );
      return 'UNKNOWN';
    }
  }

  /** The full record, for the customer profile. */
  async describe(customerId: string, channel: NotificationChannel = 'EMAIL') {
    const rows = await this.prisma.customerCommunicationPreference.findMany({
      where: { customerId, channel },
      include: { capturedBy: { select: { fullName: true } } },
    });
    return rows.map((r) => ({
      purpose: r.purpose,
      status: r.status,
      source: r.source,
      // A backfilled row has no capture date on purpose: nobody asked, so there
      // is no moment to report. The screen says "not recorded" rather than
      // inventing one.
      capturedAt: r.capturedAt,
      capturedBy: r.capturedBy?.fullName ?? null,
      note: r.note,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Record an answer. Writes the preference, keeps the legacy boolean in step,
   * and audits the change with its provenance — previous state, new state,
   * purpose, source, time, actor, and any note.
   *
   * A no-op change (same status) writes nothing and audits nothing: a preference
   * screen that is opened and saved unchanged is not a customer decision.
   */
  async capture(input: {
    customerId: string;
    purpose: CommunicationPurpose;
    status: CommunicationPreferenceStatus;
    source: CommunicationPreferenceSource;
    channel?: NotificationChannel;
    actorUserId?: string | null;
    note?: string | null;
    /** The customer acted themselves (online): there is no staff actor to record. */
    capturedByCustomer?: boolean;
  }): Promise<{ changed: boolean; from: CommunicationPreferenceStatus; to: CommunicationPreferenceStatus }> {
    const channel = input.channel ?? 'EMAIL';
    const existing = await this.prisma.customerCommunicationPreference.findUnique({
      where: { customerId_channel_purpose: { customerId: input.customerId, channel, purpose: input.purpose } },
    });
    const from = existing?.status ?? 'UNKNOWN';
    if (from === input.status && existing) {
      return { changed: false, from, to: input.status };
    }

    // An actual answer has a moment. UNKNOWN does not: it is the absence of one.
    const capturedAt = input.status === 'UNKNOWN' ? null : new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.customerCommunicationPreference.upsert({
        where: { customerId_channel_purpose: { customerId: input.customerId, channel, purpose: input.purpose } },
        create: {
          customerId: input.customerId,
          channel,
          purpose: input.purpose,
          status: input.status,
          source: input.source,
          capturedAt,
          capturedByUserId: input.capturedByCustomer ? null : (input.actorUserId ?? null),
          note: input.note ?? null,
        },
        update: {
          status: input.status,
          source: input.source,
          capturedAt,
          capturedByUserId: input.capturedByCustomer ? null : (input.actorUserId ?? null),
          note: input.note ?? null,
        },
      });

      // The documented projection: the legacy boolean follows EMAIL/MARKETING so
      // the serializers and screens that still read it never disagree with the
      // preference table. Only ALLOWED is permissive — UNKNOWN is not consent.
      if (channel === 'EMAIL' && input.purpose === 'MARKETING') {
        await tx.customer.update({
          where: { id: input.customerId },
          data: { notificationOptInEmail: input.status === 'ALLOWED' },
        });
      }
    });

    await this.audit.log({
      actorUserId: input.actorUserId ?? null,
      action: 'CUSTOMER_COMMUNICATION_PREFERENCE_UPDATED',
      entityType: 'Customer',
      entityId: input.customerId,
      beforeJson: { channel, purpose: input.purpose, status: from, source: existing?.source ?? null },
      afterJson: {
        channel,
        purpose: input.purpose,
        status: input.status,
        source: input.source,
        capturedAt,
        capturedByCustomer: !!input.capturedByCustomer,
        note: input.note ?? null,
      },
      reasonCode: 'COMMUNICATION_PREFERENCE',
    });

    return { changed: true, from, to: input.status };
  }

  /**
   * The staff-facing shorthand used by check-in, walk-in and the appointment
   * modal, where the answer arrives as a tickbox that a person just changed.
   *
   * A tick is an answer (ALLOWED). An untick is also an answer (DECLINED) —
   * but only because these callers pass the value ONLY when it changed. An
   * untouched box means nobody asked, and nothing is written.
   */
  async captureFromStaffTickbox(input: {
    customerId: string;
    agreed: boolean;
    actorUserId: string;
    note?: string;
  }): Promise<void> {
    await this.capture({
      customerId: input.customerId,
      purpose: 'MARKETING',
      status: input.agreed ? 'ALLOWED' : 'DECLINED',
      source: 'STAFF_CAPTURED',
      actorUserId: input.actorUserId,
      note: input.note ?? null,
    });
  }
}
