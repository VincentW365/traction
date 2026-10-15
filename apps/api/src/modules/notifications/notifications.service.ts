import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { TestRecordResolver, type TestRecordVerdict } from './test-record.resolver';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  NOTIFICATION_CAPABILITIES,
  NOTIFICATION_PROVIDER,
  type NotificationCapabilities,
  type NotificationProvider,
} from './providers/notification-provider.interface';
import { NotificationChannel, NotificationDeliveryStatus, NotificationReason } from '@prisma/client';
import { renderEmailContent } from './templates/email-templates';
import { NotificationTemplateStore } from './templates/template-store.service';
import { buildVehicleDescription, type TemplateData } from './templates/template-engine';
import { NO_EMAIL_ON_FILE, UNSUPPORTED_CHANNEL_REASON } from './notification-messages';
import { purposeForTemplateKey, type CommunicationPurposeName } from './consent-policy';
import { CommunicationPreferenceService } from './communication-preference.service';
import { NotificationRoutingService } from './notification-routing.service';

/**
 * CR-2026-106 — the ONE mapping from a NotificationLog row to what a person is
 * told (docs/121 §C3). "Sent" means the provider accepted the message; it is never
 * shown for a simulated or test-redirected row, and never means "delivered".
 */
export type DeliveryDisplayState =
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'TEST_REDIRECTED'
  | 'SIMULATED'
  | 'MANUAL'
  | 'CANCELLED'
  /** CR-2026-108 — about a TEST record: rendered and recorded, deliberately not sent. */
  | 'CAPTURED';

export function deliveryDisplayState(row: { status: string; simulated?: boolean | null; testRouted?: boolean | null }): DeliveryDisplayState {
  switch (row.status) {
    case 'PENDING':
    case 'SCHEDULED':
      return 'QUEUED';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'FAILED':
      return 'FAILED';
    case 'MANUAL':
      return 'MANUAL';
    case 'CANCELLED':
      return 'CANCELLED';
    // CR-2026-108 — never let a withheld test message read as queued or sent.
    case 'CAPTURED':
      return 'CAPTURED';
    case 'SENT':
      if (row.simulated) return 'SIMULATED';
      if (row.testRouted) return 'TEST_REDIRECTED';
      return 'SENT';
    default:
      return 'QUEUED';
  }
}

/** CR-2026-105c — "Fri, Sep 11, 2:40 PM" in the site's zone (falls back to the server zone). */
export function formatAppointmentWhen(at: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return at.toLocaleString('en-US', timeZone ? { ...opts, timeZone } : opts);
  } catch {
    return at.toLocaleString('en-US', opts);
  }
}

export interface QueueNotificationInput {
  entityType: string;
  entityId: string;
  /** CR-2026-112 — email is the only channel this release delivers on. */
  channel: 'EMAIL';
  templateKey: string;
  recipient: string;
  templateData: Record<string, unknown>;
  scheduledAt?: Date;
  /** CR-2026-105c — pre-rendered content (the email provider needs a body). */
  subject?: string;
  body?: string;
  /** CR-2026-112 — the reason this message went out, for history and reporting. */
  reason?: NotificationReason;
  /** CR-2026-113 — the business purpose it was sent under (TRANSACTIONAL / REMINDER / MARKETING). */
  purpose?: CommunicationPurposeName;
  /** CR-2026-112 — which manager-editable template produced it, when one did. */
  templateVersion?: number;
  /** CR-2026-106 — so the customer's Communication History (filtered by customer/vehicle) shows this message. */
  customerId?: string | null;
  vehicleId?: string | null;
  /**
   * CR-2026-108 §3 — explicit test context carried WITH the request. When present
   * the message is captured regardless of what the database lookup says (or
   * whether it worked at all). Preferred over rediscovering test-ness from
   * related rows; Stage 3's UAT booking session will populate it end-to-end.
   */
  testContext?: { testDataRunId?: string | null; runLabel?: string | null } | null;
}

/**
 * CR-2026-105c — what a booking message needs to say. Customer contact is opt-in
 * gated by the caller.
 *
 * CR-2026-112 — `phone` is gone: these messages are emails. A caller that has no
 * email for the customer passes null and nothing is sent, which the booking
 * screens state plainly rather than hiding.
 */
export interface AppointmentMessageInput {
  appointmentId: string;
  email: string | null;
  /** Used only to address the customer by name in the template. */
  customerFirstName?: string | null;
  scheduledStartAt: Date;
  durationMinutes: number;
  services: string[];
  siteName: string;
  timezone?: string;
  reference: string;
  manageUrl?: string;
  instructions?: string;
  /** CR-2026-106 — "Toyota Corolla · plate ending 34" so the customer knows WHICH car. */
  vehicle?: string;
  /** CR-2026-106 — what to do to change/cancel when there is no manage link to hand. */
  changeGuidance?: string;
  /** CR-2026-106 — history linkage (the booking messages were invisible on the customer page without it). */
  customerId?: string | null;
  vehicleId?: string | null;
  /**
   * CR-2026-108 Stage 3 — explicit UAT context. A brand-new customer created in a
   * UAT session has no history to resolve from, and the tag is written in the same
   * request, so the classification is carried rather than rediscovered.
   */
  testContext?: { testDataRunId?: string | null; runLabel?: string | null } | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(NOTIFICATION_PROVIDER)
    private provider: NotificationProvider,
    @Inject(NOTIFICATION_CAPABILITIES)
    private caps: NotificationCapabilities,
    // CR-2026-108 — @Optional so the many existing specs that construct this
    // service directly keep compiling. Absent resolver = nothing is ever treated
    // as a test record, i.e. exactly the pre-CR behaviour.
    @Optional() private testRecords?: TestRecordResolver,
    // CR-2026-112 — @Optional for the same reason, and appended so the existing
    // positional constructions keep working. Absent store = the code fallback
    // wording, which is what these flows used before this CR.
    @Optional() private templates?: NotificationTemplateStore,
    // CR-2026-114 — the recorded preference for the MARKETING sweeps. @Optional
    // and appended for the same reason; absent = fall back to the legacy boolean,
    // which is exactly the pre-CR behaviour.
    @Optional() private preferences?: CommunicationPreferenceService,
    // CR-2026-117 — resolves test-vs-live at send time. @Optional and appended
    // for the same reason; absent = the boot-time env value, i.e. pre-CR behaviour.
    @Optional() private routing?: NotificationRoutingService,
  ) {}

  /**
   * CR-2026-096 — test routing applies to EVERY send path, including these legacy
   * background flows: in TEST mode a customer recipient is replaced by the
   * configured test recipient (recorded, never concealed). A real provider in
   * TEST mode with no test recipient refuses rather than reaching a customer.
   */
  private async routeRecipient(
    intended: string,
  ): Promise<{ to: string; testRouted: boolean; simulated: boolean; blocked?: string }> {
    // CR-2026-117 — read now, not at boot, so a manager turning live sending on
    // in Settings takes effect on the next message rather than the next deploy.
    const effective = this.routing ? await this.routing.resolve(this.caps) : this.caps;
    const configured = effective.emailConfigured;
    if (effective.mode === 'LIVE') {
      return { to: intended, testRouted: false, simulated: !configured };
    }
    const testTo = effective.testEmailTo;
    if (testTo) return { to: testTo, testRouted: true, simulated: !configured };
    if (configured) {
      return {
        to: intended,
        testRouted: false,
        simulated: false,
        blocked:
          'Test routing is on but no test recipient is set — refused to contact a real customer. ' +
          'Set a test recipient in Settings, or turn live sending on.',
      };
    }
    return { to: intended, testRouted: false, simulated: true };
  }

  async queue(input: QueueNotificationInput): Promise<string> {
    // CR-2026-108 Stage 1 — decide per RECORD, before anything else. A message
    // about a test record is rendered and recorded in full but never transmitted,
    // so UAT of the public booking flow cannot reach a real person. Genuine
    // customer messages are untouched by this branch.
    const testRecord: TestRecordVerdict = this.testRecords
      ? await this.testRecords.resolve({
          entityType: input.entityType,
          entityId: input.entityId,
          customerId: input.customerId ?? null,
          vehicleId: input.vehicleId ?? null,
          testContext: input.testContext ?? null,
        })
      : { isTest: false, classification: 'GENUINE', via: null, runLabel: null };

    if (testRecord.isTest) {
      const { subject, body } = this.renderForChannel(input);
      const captured = await this.prisma.notificationLog.create({
        data: {
          entityType: input.entityType,
          entityId: input.entityId,
          channel: input.channel as NotificationChannel,
          templateKey: input.templateKey,
          // Recorded as the person it WOULD have gone to — both fields, so the UAT
          // view can show the real destination without any chance of it being read
          // as "delivered".
          recipient: input.recipient,
          intendedRecipient: input.recipient,
          testRouted: false,
          simulated: false,
          status: 'CAPTURED' as NotificationDeliveryStatus,
          ...(input.reason ? { reason: input.reason } : {}),
          purpose: input.purpose ?? purposeForTemplateKey(input.templateKey),
          failureReason: `Captured for test run ${testRecord.runLabel ?? 'unknown'} (matched via ${testRecord.via}) — not transmitted`,
          ...(subject ? { subject } : {}),
          ...(body ? { body, generatedBody: body } : {}),
          ...(input.customerId ? { customerId: input.customerId } : {}),
          ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
        },
      });
      this.logger.log(
        `Notification ${captured.id} CAPTURED (test run ${testRecord.runLabel ?? 'unknown'}, via ${testRecord.via}): ` +
          `${input.channel} "${input.templateKey}" for ${input.recipient} was not transmitted.`,
      );
      return captured.id;
    }

    const routing = await this.routeRecipient(input.recipient);

    const log = await this.prisma.notificationLog.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        channel: input.channel as NotificationChannel,
        templateKey: input.templateKey,
        recipient: routing.to,
        intendedRecipient: routing.testRouted ? input.recipient : null,
        testRouted: routing.testRouted,
        simulated: routing.simulated,
        status: input.scheduledAt ? 'SCHEDULED' : 'PENDING',
        scheduledAt: input.scheduledAt,
        // CR-2026-112 — automatic messages carry their reason and template version
        // too, so Communication History reads the same for staff-sent and
        // system-sent email.
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.templateVersion ? { templateVersion: input.templateVersion } : {}),
        // CR-2026-113 — recorded, so "why was this sent?" is answerable from the
        // log rather than reconstructed from the template key.
        purpose: input.purpose ?? purposeForTemplateKey(input.templateKey),
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
      },
    });

    // CR-2026-108 §3 — the classification could not be established, so this
    // message is being delivered WITHOUT the test safety net having actually been
    // checked. That is a real operating condition, not a log line to lose: it is
    // audited with the identifiers needed to find the record afterwards. The
    // message still goes out (a real customer must not be silently cut off), but
    // nothing anywhere records it as "positively classified as genuine".
    if (testRecord.classification === 'UNKNOWN') {
      await this.auditTestClassificationFailure(log.id, input, testRecord.failureReason);
    }

    if (routing.blocked) {
      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', failureReason: routing.blocked },
      });
      this.logger.warn(`Notification ${log.id} blocked: ${routing.blocked}`);
      return log.id;
    }

    // In Phase 1, process immediately (no BullMQ queue yet)
    // Phase 4 will replace this with BullMQ job scheduling
    if (!input.scheduledAt) {
      // The provider must see the ROUTED recipient (test redirect applied).
      await this.processNotification(log.id, { ...input, recipient: routing.to });
    }

    return log.id;
  }

  /**
   * CR-2026-108 §3 — make an unestablished test classification observable.
   * Never throws: an audit-write problem must not stop a customer message.
   */
  private async auditTestClassificationFailure(
    notificationId: string,
    input: QueueNotificationInput,
    failureReason: string | undefined,
  ): Promise<void> {
    const detail = {
      notificationId,
      entityType: input.entityType,
      entityId: input.entityId,
      customerId: input.customerId ?? null,
      vehicleId: input.vehicleId ?? null,
      channel: input.channel,
      templateKey: input.templateKey,
      failureReason: failureReason ?? 'unknown',
      outcome: 'DELIVERED_WITHOUT_CLASSIFICATION',
    };
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: null,
          action: 'NOTIFICATION_TEST_CLASSIFICATION_UNAVAILABLE',
          entityType: 'NotificationLog',
          entityId: notificationId,
          afterJson: detail as unknown as never,
          reasonCode: 'TEST_CLASSIFICATION_UNAVAILABLE',
          notes:
            'Could not determine whether this message was about a test record; it was delivered as a real customer message. ' +
            'Investigate before relying on per-record UAT suppression.',
        },
      });
    } catch (e: unknown) {
      this.logger.error(
        `Could not audit an unestablished test classification for notification ${notificationId}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * CR-2026-106 — EVERY email carries a rendered subject + body (docs/121 §C3).
   * The legacy flows (pickup-ready, reminder sweep, midday follow-up, maintenance
   * reminders) passed only a template key, which the SMTP provider refuses.
   *
   * CR-2026-108 — extracted so a CAPTURED message records exactly what a SENT one
   * would have contained. If capture rendered differently, UAT would be signing off
   * wording the customer never receives.
   */
  private renderForChannel(input: QueueNotificationInput): { subject?: string; body?: string } {
    let subject = input.subject;
    let body = input.body;
    if (!(body ?? '').trim()) {
      const rendered = renderEmailContent(input.templateKey, input.templateData);
      subject = subject ?? rendered.subject;
      body = rendered.body;
    }
    return { subject, body };
  }

  private async processNotification(
    logId: string,
    input: QueueNotificationInput,
  ) {
    try {
      const { subject, body } = this.renderForChannel(input);

      const result = await this.provider.send({
        channel: input.channel,
        recipient: input.recipient,
        templateKey: input.templateKey,
        templateData: input.templateData,
        ...(subject ? { subject } : {}),
        ...(body ? { body } : {}),
      });

      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: result.success
            ? ('SENT' as NotificationDeliveryStatus)
            : ('FAILED' as NotificationDeliveryStatus),
          providerReference: result.providerReference,
          sentAt: result.success ? new Date() : undefined,
          failureReason: result.failureReason,
          // What was actually sent, so history can show it.
          ...(subject ? { subject } : {}),
          ...(body ? { body } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Notification ${logId} failed:`, error);
      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: 'FAILED' as NotificationDeliveryStatus,
          failureReason:
            error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  /**
   * CR-2026-105c — NOT-001: confirmation on create and on reschedule, plus a
   * cancellation notice.
   *
   * CR-2026-112 — one email, rendered from the manager-editable template for the
   * matching reason (APPOINTMENT_CONFIRMATION / CHANGED / CANCELLED). The code
   * wording below is the FALLBACK for a deployment whose template table has not
   * been seeded yet, so a booking confirmation can never go out blank. The
   * caller passes `null` for email when the customer has not opted in, or has no
   * address — nothing is sent and nothing is recorded as sent.
   */
  async queueAppointmentMessage(kind: 'CONFIRMED' | 'RESCHEDULED' | 'CANCELLED', input: AppointmentMessageInput): Promise<void> {
    if (!input.email) return;

    const reason: NotificationReason =
      kind === 'CONFIRMED' ? 'APPOINTMENT_CONFIRMATION' : kind === 'RESCHEDULED' ? 'APPOINTMENT_CHANGED' : 'APPOINTMENT_CANCELLED';
    const legacyKey =
      kind === 'CONFIRMED' ? 'appointment_confirmation' : kind === 'RESCHEDULED' ? 'appointment_rescheduled' : 'appointment_cancelled';
    const when = formatAppointmentWhen(input.scheduledStartAt, input.timezone);

    // The fallback renderer's data (legacy shape) …
    const templateData: Record<string, unknown> = {
      scheduledStartAt: input.scheduledStartAt,
      siteName: input.siteName,
      services: input.services,
      reference: input.reference,
      manageUrl: input.manageUrl,
      durationMinutes: input.durationMinutes,
      customerFirstName: input.customerFirstName ?? null,
      when,
    };

    // … and the template store's placeholder data.
    const placeholders: TemplateData = {
      customerFirstName: input.customerFirstName ?? null,
      siteName: input.siteName,
      businessName: input.siteName,
      vehicleDescription: input.vehicle ?? null,
      appointmentReference: input.reference || null,
      appointmentWhen: when,
      appointmentServices: input.services.length ? input.services.join(', ') : null,
      appointmentDuration: kind !== 'CANCELLED' && input.durationMinutes > 0 ? input.durationMinutes : null,
      appointmentInstructions:
        kind === 'CANCELLED'
          ? null
          : (input.instructions ??
            (input.manageUrl ? null : (input.changeGuidance ?? null))),
      manageUrl: kind === 'CANCELLED' ? null : (input.manageUrl ?? null),
    };

    const rendered = this.templates ? await this.templates.render(reason, placeholders) : null;
    const fallback = renderEmailContent(legacyKey, templateData);

    await this.queue({
      entityType: 'Appointment',
      entityId: input.appointmentId,
      channel: 'EMAIL',
      templateKey: rendered?.templateKey ?? legacyKey,
      templateVersion: rendered?.templateVersion,
      reason,
      purpose: rendered?.purpose ?? 'TRANSACTIONAL',
      recipient: input.email,
      templateData,
      subject: rendered?.subject || fallback.subject,
      body: rendered?.body ?? fallback.body,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      testContext: input.testContext,
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — Reminder, delay, and pickup notifications
  // ---------------------------------------------------------------------------

  /**
   * Schedule a reminder notification (24h or 2h) before an appointment.
   */
  async scheduleReminder(
    appointmentId: string,
    reminderType: '24h' | '2h',
  ): Promise<string[]> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        customer: true,
        services: { include: { serviceType: true } },
        site: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException(`Appointment ${appointmentId} not found`);
    }

    const hoursOffset = reminderType === '24h' ? 24 : 2;
    const scheduledAt = new Date(
      appointment.scheduledStartAt.getTime() - hoursOffset * 60 * 60 * 1000,
    );

    // Don't schedule if the reminder time is already in the past
    if (scheduledAt <= new Date()) {
      this.logger.warn(
        `Skipping ${reminderType} reminder for appointment ${appointmentId}: scheduled time is in the past`,
      );
      return [];
    }

    const templateKey = `appointment_reminder_${reminderType}`;
    const templateData = {
      scheduledStartAt: appointment.scheduledStartAt,
      services: appointment.services.map((s) => s.serviceType.name),
      siteName: appointment.site.name,
    };

    const ids: string[] = [];

    // CR-2026-112 — email reminder. A customer with no address on file simply
    // gets no reminder; nothing is recorded as sent.
    // CR-2026-113 — a reminder is about an appointment this customer already
    // made, so it is not gated on the optional-email preference.
    if (appointment.customer.email) {
      const emailId = await this.queue({
        entityType: 'Appointment',
        entityId: appointmentId,
        channel: 'EMAIL',
        templateKey,
        reason: 'APPOINTMENT_REMINDER',
        purpose: 'REMINDER',
        recipient: appointment.customer.email,
        templateData,
        scheduledAt,
      });
      ids.push(emailId);
    }

    return ids;
  }

  /**
   * Send a delay alert if the new estimated completion exceeds the original
   * promised time by more than 15 minutes.
   */
  async sendDelayAlert(
    serviceVisitId: string,
    newEstimatedCompletion: Date,
  ): Promise<string[]> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: {
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!visit) {
      throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    }

    // Only send if delay exceeds 15 minutes from original promised time
    const originalEta = visit.currentEtaCompleteAt;
    if (originalEta) {
      const delayMs =
        newEstimatedCompletion.getTime() - originalEta.getTime();
      const delayMinutes = delayMs / (60 * 1000);
      if (delayMinutes <= 15) {
        this.logger.log(
          `Delay for visit ${serviceVisitId} is ${delayMinutes.toFixed(1)}min — under 15min threshold, skipping alert`,
        );
        return [];
      }
    }

    const templateData = {
      customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
      vehiclePlate: visit.vehicle.plateNumber,
      newEstimatedCompletion,
      siteName: visit.site.name,
    };

    const ids: string[] = [];

    // CR-2026-113 — the vehicle is with us and running late: operational.
    if (visit.customer.email) {
      const emailId = await this.queue({
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        channel: 'EMAIL',
        templateKey: 'service_delay_alert',
        reason: 'QUEUE_UPDATE',
        purpose: 'TRANSACTIONAL',
        recipient: visit.customer.email,
        templateData,
      });
      ids.push(emailId);
    }

    return ids;
  }

  /**
   * Send a "your vehicle is ready for collection" notification.
   */
  async sendReadyForPickup(serviceVisitId: string): Promise<string[]> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: {
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!visit) {
      throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    }

    const templateData = {
      customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
      vehiclePlate: visit.vehicle.plateNumber,
      vehicleMake: visit.vehicle.make,
      vehicleModel: visit.vehicle.model,
      siteName: visit.site.name,
    };

    const ids: string[] = [];

    // CR-2026-113 — telling someone their vehicle is ready IS the service, not
    // outreach: an address on file is the only condition.
    if (visit.customer.email) {
      const emailId = await this.queue({
        entityType: 'ServiceVisit',
        entityId: serviceVisitId,
        channel: 'EMAIL',
        templateKey: 'ready_for_pickup',
        reason: 'PICKUP_READY',
        purpose: 'TRANSACTIONAL',
        recipient: visit.customer.email,
        templateData,
      });
      ids.push(emailId);
    }

    return ids;
  }

  // ---------------------------------------------------------------------------
  // v4.1 — Front-desk-initiated pickup notification with channel choice
  // ---------------------------------------------------------------------------

  /**
   * Send a pickup-ready notification via channels chosen by front desk staff.
   * Supports SMS, EMAIL, and MANUAL_CALL (staff calls customer directly).
   * Every attempt is logged in NotificationLog including manual calls.
   */
  /** CR-2026-106 — the honest delivery outcome of one log row, for screens. */
  private outcomeDetail(log: { status: string; simulated?: boolean; testRouted?: boolean; failureReason?: string | null; intendedRecipient?: string | null }) {
    return {
      displayState: deliveryDisplayState(log),
      simulated: !!log.simulated,
      testRouted: !!log.testRouted,
      failureReason: log.failureReason ?? null,
      intendedRecipient: log.intendedRecipient ?? null,
    };
  }

  /**
   * CR-2026-106 — prove the outbound email path end to end: transport verification
   * (connection + authentication) followed by a REAL send to the given address,
   * recorded in NotificationLog with the provider's own response. Sends to exactly
   * the address a CONFIG_EDIT user typed — this is a system test message, not a
   * customer message, so TEST-mode redirection does not apply.
   */
  async verifyEmail(to: string, userId: string) {
    const stamp = new Date().toISOString();
    const transport = this.caps.emailTransport ?? null;
    if (!this.caps.emailConfigured) {
      return {
        verified: false,
        configured: false,
        mode: this.caps.mode,
        transport,
        transportCheck: { ok: false, detail: 'EMAIL_PROVIDER is "stub" — no real mail can be sent from this deployment' },
        send: null,
      };
    }
    const transportCheck = this.provider.verify ? await this.provider.verify('EMAIL') : { ok: true, detail: 'not checked' };

    const content = renderEmailContent('smtp_verification', { stamp, siteName: "Bert's Auto Parts Service Centre" });
    const log = await this.prisma.notificationLog.create({
      data: {
        entityType: 'System',
        entityId: '00000000-0000-0000-0000-000000000000',
        channel: 'EMAIL',
        templateKey: 'smtp_verification',
        templateVersion: 1,
        recipient: to,
        status: 'PENDING',
        initiatedByUserId: userId,
        subject: content.subject,
        body: content.body,
      },
    });
    let result: { success: boolean; providerReference?: string; failureReason?: string; accepted?: string[]; rejected?: string[]; response?: string };
    try {
      result = await this.provider.send({ channel: 'EMAIL', recipient: to, templateKey: 'smtp_verification', templateData: { stamp }, ...content });
    } catch (error) {
      result = { success: false, failureReason: error instanceof Error ? error.message : 'Provider send failed' };
    }
    await this.prisma.notificationLog.update({
      where: { id: log.id },
      data: {
        status: result.success ? 'SENT' : 'FAILED',
        providerReference: result.providerReference,
        failureReason: result.failureReason,
        sentAt: result.success ? new Date() : undefined,
      },
    });
    return {
      verified: transportCheck.ok && result.success,
      configured: true,
      mode: this.caps.mode,
      transport,
      transportCheck,
      send: {
        logId: log.id,
        to,
        success: result.success,
        providerReference: result.providerReference ?? null,
        accepted: result.accepted ?? [],
        rejected: result.rejected ?? [],
        response: result.response ?? null,
        failureReason: result.failureReason ?? null,
      },
    };
  }

  async sendPickupReady(
    serviceVisitId: string,
    channels: string[],
    userId: string,
  ): Promise<{ sent: Array<{ channel: string; status: string; recipient: string; displayState?: string; simulated?: boolean; testRouted?: boolean; failureReason?: string | null; intendedRecipient?: string | null }> }> {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: serviceVisitId },
      include: {
        customer: true,
        vehicle: true,
        site: true,
      },
    });

    if (!visit) {
      throw new NotFoundException(`ServiceVisit ${serviceVisitId} not found`);
    }

    const results: Array<{ channel: string; status: string; recipient: string; displayState?: string; simulated?: boolean; testRouted?: boolean; failureReason?: string | null; intendedRecipient?: string | null }> = [];

    for (const channel of channels) {
      if (channel === 'EMAIL') {
        // CR-2026-112 — no email address is an operational fact, not a silent
        // no-op: the panel must say so instead of showing nothing happened.
        if (!visit.customer.email) {
          results.push({
            channel: 'EMAIL',
            status: 'FAILED',
            recipient: '',
            displayState: 'FAILED',
            failureReason: NO_EMAIL_ON_FILE,
          });
          continue;
        }
        const rendered = this.templates
          ? await this.templates.render('PICKUP_READY', {
              customerFirstName: visit.customer.firstName,
              vehicleDescription: buildVehicleDescription(visit.vehicle),
              registrationNumber: visit.vehicle.plateNumber,
              siteName: visit.site.name,
              businessName: visit.site.name,
              pickupDetails: null,
            })
          : null;
        const logId = await this.queue({
          entityType: 'ServiceVisit',
          entityId: serviceVisitId,
          channel: 'EMAIL',
          templateKey: rendered?.templateKey ?? 'pickup_ready',
          reason: 'PICKUP_READY',
          purpose: rendered?.purpose ?? 'TRANSACTIONAL',
          recipient: visit.customer.email,
          ...(rendered ? { subject: rendered.subject, body: rendered.body } : {}),
          templateData: {
            customerName: `${visit.customer.firstName} ${visit.customer.lastName}`,
            customerFirstName: visit.customer.firstName,
            vehiclePlate: visit.vehicle.plateNumber,
            vehicleMake: visit.vehicle.make,
            vehicleModel: visit.vehicle.model,
            siteName: visit.site.name,
          },
          customerId: visit.customerId,
          vehicleId: visit.vehicleId,
        });
        // Update with initiatedByUserId; CR-2026-106 — report the REAL outcome from
        // the log (status was hard-coded 'SENT' before, docs/121 §C3).
        const emailLog = await this.prisma.notificationLog.update({
          where: { id: logId },
          data: { initiatedByUserId: userId, templateVersion: rendered?.templateVersion ?? 1 },
        });
        results.push({ channel: 'EMAIL', status: emailLog.status, recipient: visit.customer.email, ...this.outcomeDetail(emailLog) });

      } else if (channel === 'MANUAL_CALL') {
        // Log that staff chose to call manually — no actual send
        await this.prisma.notificationLog.create({
          data: {
            entityType: 'ServiceVisit',
            entityId: serviceVisitId,
            channel: 'MANUAL_CALL',
            templateKey: 'pickup_ready',
            templateVersion: 1,
            recipient: visit.customer.phone,
            status: 'MANUAL',
            initiatedByUserId: userId,
            sentAt: new Date(),
          },
        });
        results.push({ channel: 'MANUAL_CALL', status: 'MANUAL', recipient: visit.customer.phone });

      } else {
        // CR-2026-112 — an out-of-date client asking for a channel this release
        // cannot deliver is told so. Nothing is recorded: nothing was attempted.
        results.push({
          channel,
          status: 'FAILED',
          recipient: '',
          displayState: 'FAILED',
          failureReason: UNSUPPORTED_CHANNEL_REASON,
        });
      }
    }

    return {
      sent: results,
    };
  }

  /**
   * Get notification log entries for a given entity.
   */
  async getLogForEntity(entityId: string) {
    return this.prisma.notificationLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * CR-2026-108 Stage 1 — the UAT results view: every message that was withheld
   * because it was about a test record, with what the customer WOULD have
   * received. This is what a tester reads instead of a mailbox.
   *
   * Staff-facing and unmasked ON PURPOSE: these are test records by definition,
   * and a tester has to be able to check the exact wording, recipient and channel.
   * It is still permission-gated (CONFIG_VIEW) and never reachable publicly.
   */
  async listCapturedNotifications(
    opts: { take?: number; skip?: number; runLabel?: string; actorUserId?: string } = {},
  ) {
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    const skip = Math.max(opts.skip ?? 0, 0);

    // CR-2026-108 §4 — reading captured content means reading what a customer
    // would have been told, including their address. Permission-gated to
    // NOTIFY_CAPTURED_VIEW and audited: who looked, at which run, and when.
    if (opts.actorUserId) {
      try {
        await this.prisma.auditLog.create({
          data: {
            actorUserId: opts.actorUserId,
            action: 'NOTIFICATION_CAPTURED_VIEWED',
            entityType: 'NotificationLog',
            entityId: null as unknown as string,
            afterJson: { runLabel: opts.runLabel ?? null, take, skip } as unknown as never,
            reasonCode: 'UAT_EVIDENCE_REVIEW',
          },
        });
      } catch {
        // Never block a tester on an audit write; the request itself is still
        // permission-gated and logged by the platform.
      }
    }

    const total = await this.prisma.notificationLog.count({
      where: { status: 'CAPTURED' as NotificationDeliveryStatus },
    });
    const rows = await this.prisma.notificationLog.findMany({
      where: { status: 'CAPTURED' as NotificationDeliveryStatus },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select: {
        id: true, createdAt: true, entityType: true, entityId: true,
        channel: true, templateKey: true, recipient: true, intendedRecipient: true,
        subject: true, body: true, failureReason: true,
        customer: { select: { id: true, firstName: true, lastName: true, testDataRun: { select: { label: true } } } },
        vehicle: { select: { id: true, plateNumber: true, testDataRun: { select: { label: true } } } },
      },
    });

    const items = rows
      .map((r) => ({
        id: r.id,
        capturedAt: r.createdAt,
        runLabel: r.customer?.testDataRun?.label ?? r.vehicle?.testDataRun?.label ?? null,
        about: { entityType: r.entityType, entityId: r.entityId },
        channel: r.channel,
        templateKey: r.templateKey,
        // The address the message was addressed to and did NOT go to.
        wouldHaveGoneTo: r.intendedRecipient ?? r.recipient,
        subject: r.subject,
        body: r.body,
        note: r.failureReason,
        customer: r.customer ? { id: r.customer.id, name: `${r.customer.firstName} ${r.customer.lastName}` } : null,
        vehicle: r.vehicle ? { id: r.vehicle.id, plateNumber: r.vehicle.plateNumber } : null,
      }))
      .filter((i) => !opts.runLabel || i.runLabel === opts.runLabel);

    return {
      /** Captured rows in the database (before any runLabel filter). */
      total,
      /** Rows in THIS page after the runLabel filter. */
      returned: items.length,
      take,
      skip,
      items,
    };
  }

  /**
   * DMAIC Rule 2 — Midday completion follow-up.
   *
   * Sends a same-day follow-up to customers whose job was COMPLETED before 12:00 PM
   * (site-local time) — NOT merely in queue before noon. Completion is detected via
   * the `COMPLETED` QueueEvent written when a technician marks work done.
   *
   * Idempotent: each visit is followed up at most once (deduped on NotificationLog
   * templateKey `midday_followup`), so the same completion never sends duplicates and
   * the batch is safe to run repeatedly (e.g. on a schedule around noon).
   *
   * Touches no scheduling/ETA/rank/bay logic — read-only over completion events.
   *
   * @param now injectable clock for testability (defaults to current time)
   */
  async sendMiddayCompletionFollowUp(
    siteId: string,
    now: Date = new Date(),
  ): Promise<{ sent: number; skipped: number }> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { timezone: true },
    });
    const tz = site?.timezone || 'America/Jamaica';
    const todayKey = this.zonedParts(now, tz).date;

    // Look back far enough to cover "today" in any timezone; filter precisely below.
    const since = new Date(now.getTime() - 36 * 60 * 60 * 1000);

    const completions = await this.prisma.queueEvent.findMany({
      where: {
        eventType: 'COMPLETED',
        createdAt: { gte: since, lte: now },
        serviceVisit: { siteId },
      },
      select: {
        createdAt: true,
        serviceVisit: {
          select: {
            id: true,
            customerId: true,
            customer: {
              select: { firstName: true, phone: true, email: true, notificationOptInEmail: true },
            },
            vehicle: { select: { plateNumber: true, make: true, model: true, modelYear: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    let sent = 0;
    let skipped = 0;
    const handled = new Set<string>();

    for (const ev of completions) {
      const visit = ev.serviceVisit;
      if (!visit || handled.has(visit.id)) continue;

      // Rule 2: completed TODAY and BEFORE 12:00 PM site-local.
      const parts = this.zonedParts(ev.createdAt, tz);
      if (parts.date !== todayKey || parts.hour >= 12) continue;
      handled.add(visit.id);

      // Idempotency: already followed up for this visit?
      const already = await this.prisma.notificationLog.count({
        where: { entityType: 'ServiceVisit', entityId: visit.id, templateKey: 'midday_followup' },
      });
      if (already > 0) { skipped++; continue; }

      const { customer, vehicle } = visit;
      // CR-2026-112 — email is the channel, so email consent and an address are
      // what decide whether this follow-up can go out at all.
      // CR-2026-113 — a thank-you after the visit is optional outreach, so the
      // customer's preference DOES gate it.
      // CR-2026-114 — and "opted in" now means an actual recorded ALLOWED, not
      // the absence of a refusal. An automatic flow never overrides.
      if (!customer.email) { skipped++; continue; }
      const allowed = this.preferences
        ? (await this.preferences.statusFor(visit.customerId, 'MARKETING')) === 'ALLOWED'
        : customer.notificationOptInEmail;
      if (!allowed) { skipped++; continue; }

      const vehicleDesc = [vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.plateNumber;
      const message = `Hi ${customer.firstName}! Your ${vehicleDesc} was completed this morning at Bert's. Thank you for choosing us — we hope everything's running smoothly, and we'll see you next service!`;

      await this.queue({
        entityType: 'ServiceVisit',
        entityId: visit.id,
        channel: 'EMAIL',
        templateKey: 'midday_followup',
        purpose: 'MARKETING',
        recipient: customer.email,
        templateData: { message, customerFirstName: customer.firstName, vehicleDescription: vehicleDesc },
      });

      sent++;
    }

    this.logger.log(`Midday completion follow-up: ${sent} sent, ${skipped} skipped for site ${siteId}`);
    return { sent, skipped };
  }

  // ---------------------------------------------------------------------------
  // CR-2026-056 — 24-hour appointment reminder sweep
  // ---------------------------------------------------------------------------

  /**
   * Send a one-time reminder for every upcoming appointment that has entered the
   * reminder window (default 24h before `scheduledStartAt`). Run on a schedule
   * (hourly cron) — the dedup makes it safe to run repeatedly and at any cadence.
   *
   * - Window: appointments with `scheduledStartAt` in (now, now + reminderHours].
   *   Sending as soon as an appointment enters the window means the reminder goes
   *   out ~`reminderHours` before the appointment, give or take the cron interval.
   * - Statuses: only still-upcoming, non-terminal appointments (DRAFT, CONFIRMED,
   *   RESCHEDULED) — never CHECKED_IN / IN_PROGRESS / COMPLETED / MISSED / CANCELLED.
   * - Idempotent: one reminder per appointment, deduped on NotificationLog
   *   templateKey `appointment_reminder_24h`.
   * - Respects customer email opt-in (CR-2026-112: email is the only channel).
   * - Sends immediately (no `scheduledAt`) — the sweep itself IS the schedule.
   *
   * Gated by business rules `appointment_reminder_enabled` (default true) and
   * `appointment_reminder_hours` (default 24). Read-only over scheduling/queue.
   *
   * @param now injectable clock for testability (defaults to current time)
   */
  async sweepAppointmentReminders(
    now: Date = new Date(),
  ): Promise<{ sent: number; skipped: number }> {
    const enabledRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'appointment_reminder_enabled', effectiveTo: null },
    });
    if (enabledRule && enabledRule.valueJson === false) {
      return { sent: 0, skipped: 0 };
    }

    const hoursRule = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'appointment_reminder_hours', effectiveTo: null },
    });
    const reminderHours = (hoursRule?.valueJson as number) ?? 24;
    const windowEnd = new Date(now.getTime() + reminderHours * 60 * 60 * 1000);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        status: { in: ['DRAFT', 'CONFIRMED', 'RESCHEDULED'] },
        scheduledStartAt: { gt: now, lte: windowEnd },
      },
      include: {
        customer: true,
        services: { include: { serviceType: true } },
        site: true,
      },
    });

    let sent = 0;
    let skipped = 0;

    for (const appt of appointments) {
      // Idempotency: already reminded for this appointment? CR-2026-112 — the
      // template-store key counts too, so an appointment reminded before this CR
      // is never reminded a second time by the renamed template.
      const already = await this.prisma.notificationLog.count({
        where: {
          entityType: 'Appointment',
          entityId: appt.id,
          OR: [
            { templateKey: { in: ['appointment_reminder_24h', 'APPOINTMENT_REMINDER_EMAIL'] } },
            { reason: 'APPOINTMENT_REMINDER' },
          ],
        },
      });
      if (already > 0) {
        skipped++;
        continue;
      }

      const customer = appt.customer;
      // CR-2026-113 — a reminder about an appointment the customer booked is not
      // optional outreach; only a missing address stops it.
      if (!customer.email) {
        skipped++;
        continue;
      }

      const templateData = {
        scheduledStartAt: appt.scheduledStartAt,
        services: appt.services.map((s) => s.serviceType.name),
        siteName: appt.site.name,
        customerFirstName: customer.firstName,
      };

      // CR-2026-112 — manager-editable wording, with the code renderer as the
      // fallback for a deployment whose template table is not seeded.
      const rendered = this.templates
        ? await this.templates.render('APPOINTMENT_REMINDER', {
            customerFirstName: customer.firstName,
            siteName: appt.site.name,
            businessName: appt.site.name,
            appointmentReference: appt.appointmentNumber ?? null,
            appointmentWhen: formatAppointmentWhen(appt.scheduledStartAt, appt.site.timezone ?? undefined),
            appointmentServices: appt.services.map((s) => s.serviceType.name).join(', ') || null,
            appointmentInstructions: null,
          })
        : null;

      await this.queue({
        entityType: 'Appointment',
        entityId: appt.id,
        channel: 'EMAIL',
        templateKey: rendered?.templateKey ?? 'appointment_reminder_24h',
        templateVersion: rendered?.templateVersion,
        reason: 'APPOINTMENT_REMINDER',
        purpose: rendered?.purpose ?? 'REMINDER',
        recipient: customer.email,
        ...(rendered ? { subject: rendered.subject, body: rendered.body } : {}),
        templateData,
        customerId: appt.customerId,
        vehicleId: appt.vehicleId,
      });
      sent++;
    }

    this.logger.log(
      `Appointment reminders: ${sent} sent, ${skipped} skipped (window ${reminderHours}h)`,
    );
    return { sent, skipped };
  }

  /** Year-month-day and hour of a timestamp in a given IANA timezone. */
  private zonedParts(date: Date, tz: string): { date: string; hour: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const o: Record<string, string> = {};
    for (const p of parts) o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 };
  }
}
