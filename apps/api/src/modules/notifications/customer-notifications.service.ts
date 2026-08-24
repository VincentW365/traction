import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationReason, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  NOTIFICATION_CAPABILITIES,
  NOTIFICATION_PROVIDER,
  NotificationCapabilities,
  NotificationProvider,
} from './providers/notification-provider.interface';
import { toE164Jamaica } from './providers/twilio.provider';
import { DEFAULT_TEMPLATES } from './templates/default-templates';
import {
  buildVehicleDescription,
  findDisallowedPlaceholders,
  findUnresolvedInFinal,
  isValidEmail,
  isValidMobileNumber,
  renderTemplate,
  smsSegmentInfo,
  TemplateData,
} from './templates/template-engine';

/**
 * CR-2026-096 — unified customer SMS/email notifications.
 *
 * One pipeline for every staff-initiated customer message (service due, queue
 * progress, pickup, custom): Generate → Review → Edit → Preview → Send → Track.
 * Wording comes from admin-editable NotificationTemplate rows; the exact text
 * sent (after staff edits) is snapshotted on NotificationLog so later template
 * edits never rewrite history.
 */

const BUSINESS_NAME = "Bert's Service Centre";

export interface ComposeInput {
  reason: NotificationReason;
  customerId: string;
  vehicleId?: string;
  serviceVisitId?: string;
  recommendationId?: string;
}

export interface SendInput extends ComposeInput {
  channels: Array<'SMS' | 'EMAIL'>;
  sms?: { recipient: string; body: string };
  email?: { recipient: string; subject: string; body: string };
  /** Staff explicitly confirmed a repeat pickup notification. */
  confirmDuplicate?: boolean;
  /** Staff explicitly confirmed sending despite a recorded opt-out. */
  overrideOptOut?: boolean;
  /** Client-generated UUID; makes double-click sends idempotent. */
  clientRequestId?: string;
}

/** Simple per-user send throttle: at most N send requests per minute. */
const SEND_RATE_LIMIT = 20;

@Injectable()
export class CustomerNotificationsService {
  private readonly logger = new Logger(CustomerNotificationsService.name);
  private readonly sendTimestamps = new Map<string, number[]>();

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    @Inject(NOTIFICATION_PROVIDER) private provider: NotificationProvider,
    @Inject(NOTIFICATION_CAPABILITIES) private caps: NotificationCapabilities,
  ) {}

  // -------------------------------------------------------------------------
  // Capabilities — what this deployment can actually deliver
  // -------------------------------------------------------------------------

  capabilities() {
    return {
      smsConfigured: this.caps.smsConfigured,
      emailConfigured: this.caps.emailConfigured,
      mode: this.caps.mode,
      testRoutingActive: this.caps.mode === 'TEST',
    };
  }

  // -------------------------------------------------------------------------
  // Templates — admin-editable wording
  // -------------------------------------------------------------------------

  /** Create-if-missing seeding; never overwrites an admin's edited wording. */
  async ensureDefaultTemplates(): Promise<number> {
    let created = 0;
    for (const t of DEFAULT_TEMPLATES) {
      const existing = await this.prisma.notificationTemplate.findUnique({
        where: { key: t.key },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.notificationTemplate.create({
        data: {
          key: t.key,
          reason: t.reason as NotificationReason,
          channel: t.channel,
          name: t.name,
          subject: t.subject ?? null,
          body: t.body,
        },
      });
      created++;
    }
    return created;
  }

  async listTemplates() {
    await this.ensureDefaultTemplates();
    return this.prisma.notificationTemplate.findMany({
      orderBy: [{ reason: 'asc' }, { channel: 'asc' }],
      include: { updatedBy: { select: { fullName: true } } },
    });
  }

  async updateTemplate(
    key: string,
    input: { name?: string; subject?: string | null; body?: string; enabled?: boolean },
    userId: string,
  ) {
    const existing = await this.prisma.notificationTemplate.findUnique({ where: { key } });
    if (!existing) throw new NotFoundException(`Template ${key} not found`);

    if (input.body !== undefined) {
      const bad = findDisallowedPlaceholders(input.body);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Unknown placeholders: ${bad.map((b) => `{{${b}}}`).join(', ')}. Only allow-listed placeholders may be used.`,
        );
      }
    }
    if (input.subject) {
      const bad = findDisallowedPlaceholders(input.subject);
      if (bad.length > 0) {
        throw new BadRequestException(
          `Unknown placeholders in subject: ${bad.map((b) => `{{${b}}}`).join(', ')}`,
        );
      }
    }

    const contentChanged =
      (input.body !== undefined && input.body !== existing.body) ||
      (input.subject !== undefined && input.subject !== existing.subject);

    const updated = await this.prisma.notificationTemplate.update({
      where: { key },
      data: {
        name: input.name ?? undefined,
        subject: input.subject === undefined ? undefined : input.subject,
        body: input.body ?? undefined,
        enabled: input.enabled ?? undefined,
        version: contentChanged ? { increment: 1 } : undefined,
        updatedByUserId: userId,
      },
    });

    await this.audit.log({
      actorUserId: userId,
      action: 'NOTIFICATION_TEMPLATE_UPDATED',
      entityType: 'NotificationTemplate',
      entityId: existing.id,
      beforeJson: { subject: existing.subject, body: existing.body, enabled: existing.enabled, version: existing.version },
      afterJson: { subject: updated.subject, body: updated.body, enabled: updated.enabled, version: updated.version },
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Compose — context + generated drafts for the composer
  // -------------------------------------------------------------------------

  async compose(input: ComposeInput) {
    const context = await this.loadContext(input);
    const data = context.templateData;

    const smsTemplate = await this.getTemplate(input.reason, 'SMS');
    const emailTemplate = await this.getTemplate(input.reason, 'EMAIL');

    const smsDraft = smsTemplate ? renderTemplate(smsTemplate.body, data) : null;
    const emailSubjectDraft = emailTemplate?.subject
      ? renderTemplate(emailTemplate.subject, data)
      : null;
    const emailBodyDraft = emailTemplate ? renderTemplate(emailTemplate.body, data) : null;

    // Duplicate awareness: has this reason already been sent for this visit?
    const priorSend =
      input.serviceVisitId != null
        ? await this.prisma.notificationLog.findFirst({
            where: {
              entityType: 'ServiceVisit',
              entityId: input.serviceVisitId,
              OR: [
                { reason: input.reason },
                // Legacy pickup sends predate `reason`
                ...(input.reason === 'PICKUP_READY'
                  ? [{ templateKey: { in: ['pickup_ready', 'ready_for_pickup'] } }]
                  : []),
              ],
              status: { in: ['SENT', 'DELIVERED', 'MANUAL'] },
            },
            orderBy: { createdAt: 'desc' },
            select: { channel: true, sentAt: true, createdAt: true, status: true, testRouted: true, simulated: true },
          })
        : null;

    // Previous contact for the service-due workflow (avoid repeat-messaging).
    const previousContact =
      input.reason === 'SERVICE_DUE'
        ? await this.prisma.notificationLog.findFirst({
            where: { customerId: input.customerId, reason: 'SERVICE_DUE' },
            orderBy: { createdAt: 'desc' },
            select: { channel: true, sentAt: true, createdAt: true, status: true },
          })
        : null;

    const c = context.customer;
    const smsValid = !!c.phone && isValidMobileNumber(c.phone);
    const emailValid = !!c.email && isValidEmail(c.email);

    return {
      reason: input.reason,
      customer: {
        id: c.id,
        name: `${c.firstName} ${c.lastName}`,
        phone: c.phone ?? null,
        email: c.email ?? null,
        allowSms: c.notificationOptInSms,
        allowEmail: c.notificationOptInEmail,
        smsValid,
        emailValid,
      },
      vehicle: context.vehicle
        ? {
            id: context.vehicle.id,
            description: String(data.vehicleDescription ?? ''),
            registration: context.vehicle.plateNumber,
          }
        : null,
      visit: context.visit
        ? { id: context.visit.id, ticketNumber: context.ticketNumber ?? null, status: context.visit.status }
        : null,
      serviceDue: context.serviceDue,
      sms: smsTemplate
        ? {
            templateKey: smsTemplate.key,
            templateVersion: smsTemplate.version,
            enabled: smsTemplate.enabled,
            body: smsDraft?.text ?? '',
            ...smsSegmentInfo(smsDraft?.text ?? ''),
          }
        : null,
      email: emailTemplate
        ? {
            templateKey: emailTemplate.key,
            templateVersion: emailTemplate.version,
            enabled: emailTemplate.enabled,
            subject: emailSubjectDraft?.text ?? emailTemplate.subject ?? '',
            body: emailBodyDraft?.text ?? '',
          }
        : null,
      priorSend,
      previousContact,
      capabilities: this.capabilities(),
    };
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async send(input: SendInput, userId: string) {
    this.enforceRateLimit(userId);

    if (!input.channels?.length) {
      throw new BadRequestException('Select at least one channel (SMS or Email).');
    }

    // Idempotency: the same clientRequestId never sends twice.
    if (input.clientRequestId) {
      const existing = await this.prisma.notificationLog.findFirst({
        where: { clientRequestId: { startsWith: input.clientRequestId } },
        select: { id: true, status: true, channel: true, recipient: true },
      });
      if (existing) {
        return { duplicate: true, sent: [], alreadyProcessed: existing };
      }
    }

    const context = await this.loadContext(input);
    const c = context.customer;

    // Duplicate pickup guard — resend is allowed, but only deliberately.
    if (input.reason === 'PICKUP_READY' && input.serviceVisitId && !input.confirmDuplicate) {
      const prior = await this.prisma.notificationLog.findFirst({
        where: {
          entityType: 'ServiceVisit',
          entityId: input.serviceVisitId,
          OR: [
            { reason: 'PICKUP_READY' },
            { templateKey: { in: ['pickup_ready', 'ready_for_pickup'] } },
          ],
          status: { in: ['SENT', 'DELIVERED', 'MANUAL'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (prior) {
        // `errors` survives the global exception filter as `details` in the body.
        throw new ConflictException({
          message: 'A pickup notification was already sent to this customer. Send another?',
          errors: {
            code: 'DUPLICATE_PICKUP',
            prior: { channel: prior.channel, sentAt: prior.sentAt ?? prior.createdAt, status: prior.status },
          },
        });
      }
    }

    const results: Array<{
      channel: string;
      status: string;
      recipient: string;
      logId: string;
      testRouted: boolean;
      simulated: boolean;
    }> = [];

    for (const channel of input.channels) {
      const payload = channel === 'SMS' ? input.sms : input.email;
      if (!payload) {
        throw new BadRequestException(`${channel} selected but no ${channel} content provided.`);
      }

      // --- Recipient validation (send-to override allowed; master data untouched)
      const recipient = payload.recipient?.trim();
      if (channel === 'SMS') {
        if (!recipient || !isValidMobileNumber(recipient)) {
          throw new BadRequestException('No valid mobile number available.');
        }
      } else {
        if (!recipient || !isValidEmail(recipient)) {
          throw new BadRequestException('No valid email address available.');
        }
      }

      // --- Opt-out: never silently overridden
      const optedOut = channel === 'SMS' ? !c.notificationOptInSms : !c.notificationOptInEmail;
      if (optedOut && !input.overrideOptOut) {
        throw new ConflictException({
          message: `Customer has opted out of ${channel === 'SMS' ? 'SMS' : 'email'} messages. Confirm to send anyway.`,
          errors: { code: 'OPT_OUT', channel },
        });
      }

      // --- Final content validation
      const body = payload.body?.trim() ?? '';
      if (!body) throw new BadRequestException(`${channel} message is empty.`);
      const unresolved = findUnresolvedInFinal(body);
      const subject = channel === 'EMAIL' ? (input.email!.subject?.trim() ?? '') : undefined;
      if (channel === 'EMAIL') {
        if (!subject) throw new BadRequestException('Email subject is empty.');
        unresolved.push(...findUnresolvedInFinal(subject));
      }
      if (unresolved.length > 0) {
        throw new BadRequestException(
          `Message still contains unfilled placeholders: ${[...new Set(unresolved)].map((u) => `{{${u}}}`).join(', ')}. Fill or remove them before sending.`,
        );
      }

      // --- Template snapshot for audit (what was generated vs what was sent)
      const template = await this.getTemplate(input.reason, channel);
      const generated = template ? renderTemplate(template.body, context.templateData).text : null;

      // --- Test routing (never concealed; intended recipient always retained)
      const routing = this.resolveRouting(channel, recipient);

      // --- Record first (DRAFT→SENDING semantics collapsed into one row)
      const log = await this.prisma.notificationLog.create({
        data: {
          entityType: context.visit ? 'ServiceVisit' : 'Customer',
          entityId: context.visit?.id ?? c.id,
          channel,
          templateKey: template?.key ?? `${input.reason}_${channel}`,
          templateVersion: template?.version ?? 1,
          recipient: routing.to,
          intendedRecipient: routing.testRouted ? recipient : null,
          testRouted: routing.testRouted,
          simulated: routing.simulated,
          status: 'PENDING',
          reason: input.reason,
          subject: subject ?? null,
          body,
          generatedBody: generated,
          customerId: c.id,
          vehicleId: context.vehicle?.id ?? null,
          initiatedByUserId: userId,
          clientRequestId: input.clientRequestId ? `${input.clientRequestId}:${channel}` : null,
        },
      });

      // --- Deliver
      let status: 'SENT' | 'FAILED' = 'SENT';
      let providerReference: string | undefined;
      let failureReason: string | undefined;
      try {
        const result = await this.provider.send({
          channel,
          recipient: routing.to,
          templateKey: template?.key ?? input.reason,
          templateData: context.templateData as Record<string, unknown>,
          body,
          subject,
        });
        status = result.success ? 'SENT' : 'FAILED';
        providerReference = result.providerReference;
        failureReason = result.failureReason;
      } catch (error) {
        status = 'FAILED';
        failureReason = error instanceof Error ? error.message : 'Provider send failed';
      }

      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status,
          providerReference,
          failureReason,
          sentAt: status === 'SENT' ? new Date() : undefined,
        },
      });

      await this.audit.log({
        actorUserId: userId,
        action: status === 'SENT' ? 'CUSTOMER_NOTIFICATION_SENT' : 'CUSTOMER_NOTIFICATION_FAILED',
        entityType: 'NotificationLog',
        entityId: log.id,
        afterJson: {
          reason: input.reason,
          channel,
          intendedRecipient: recipient,
          actualRecipient: routing.to,
          testRouted: routing.testRouted,
          simulated: routing.simulated,
          recipientOverridden: this.isOverride(channel, recipient, c),
          optOutOverridden: optedOut,
          edited: generated !== null && generated !== body,
          templateKey: template?.key,
          templateVersion: template?.version,
        },
      });

      results.push({
        channel,
        status,
        recipient: routing.to,
        logId: log.id,
        testRouted: routing.testRouted,
        simulated: routing.simulated,
      });

      // --- Business outcome: due-service follow-up becomes CONTACTED only after
      //     a send actually succeeded (never merely because the composer opened).
      if (status === 'SENT' && input.reason === 'SERVICE_DUE' && input.recommendationId) {
        await this.prisma.maintenanceRecommendation.updateMany({
          where: {
            id: input.recommendationId,
            contactStatus: { in: ['NOT_CONTACTED', 'CONTACTED'] },
          },
          data: {
            contactStatus: 'CONTACTED',
            lastContactedAt: new Date(),
            lastContactLogId: log.id,
          },
        });
      }
    }

    return { duplicate: false, sent: results };
  }

  /** Record a manual (phone/in-person) contact without sending anything. */
  async markManualContact(
    input: {
      customerId: string;
      vehicleId?: string;
      serviceVisitId?: string;
      recommendationId?: string;
      reason: NotificationReason;
      method: 'PHONE_CALL' | 'IN_PERSON' | 'OTHER';
      note?: string;
    },
    userId: string,
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw new NotFoundException('Customer not found');
    if (input.method === 'OTHER' && !input.note?.trim()) {
      throw new BadRequestException('A brief note is required for "Other".');
    }

    const log = await this.prisma.notificationLog.create({
      data: {
        entityType: input.serviceVisitId ? 'ServiceVisit' : 'Customer',
        entityId: input.serviceVisitId ?? input.customerId,
        channel: 'MANUAL_CALL',
        templateKey: `manual_${input.method.toLowerCase()}`,
        recipient: customer.phone ?? '—',
        status: 'MANUAL',
        reason: input.reason,
        body: input.note?.trim() || `Contacted manually (${input.method.replace(/_/g, ' ').toLowerCase()})`,
        customerId: input.customerId,
        vehicleId: input.vehicleId ?? null,
        initiatedByUserId: userId,
        sentAt: new Date(),
      },
    });

    if (input.reason === 'SERVICE_DUE' && input.recommendationId) {
      await this.prisma.maintenanceRecommendation.updateMany({
        where: { id: input.recommendationId, contactStatus: { in: ['NOT_CONTACTED', 'CONTACTED'] } },
        data: { contactStatus: 'CONTACTED', lastContactedAt: new Date(), lastContactLogId: log.id },
      });
    }

    await this.audit.log({
      actorUserId: userId,
      action: 'CUSTOMER_CONTACTED_MANUALLY',
      entityType: 'NotificationLog',
      entityId: log.id,
      afterJson: { reason: input.reason, method: input.method },
    });

    return { logId: log.id };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async history(filter: { customerId?: string; vehicleId?: string; serviceVisitId?: string }) {
    const where: Prisma.NotificationLogWhereInput = filter.serviceVisitId
      ? { entityType: 'ServiceVisit', entityId: filter.serviceVisitId }
      : filter.vehicleId
        ? { vehicleId: filter.vehicleId }
        : filter.customerId
          ? { customerId: filter.customerId }
          : {};
    if (!Object.keys(where).length) {
      throw new BadRequestException('Provide customerId, vehicleId, or serviceVisitId.');
    }

    const rows = await this.prisma.notificationLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        initiatedBy: { select: { fullName: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
      },
    });

    return rows.map((n) => ({
      id: n.id,
      createdAt: n.createdAt,
      sentAt: n.sentAt,
      reason: n.reason,
      templateKey: n.templateKey,
      channel: n.channel,
      recipient: n.recipient,
      intendedRecipient: n.intendedRecipient,
      testRouted: n.testRouted,
      simulated: n.simulated,
      subject: n.subject,
      preview: n.body ? (n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body) : null,
      status: n.status,
      failureReason: n.failureReason,
      sentBy: n.initiatedBy?.fullName ?? null,
      vehicle: n.vehicle ? { plateNumber: n.vehicle.plateNumber, make: n.vehicle.make, model: n.vehicle.model } : null,
    }));
  }

  /** Full record for one notification (authorized staff drill-in). */
  async getNotification(id: string) {
    const n = await this.prisma.notificationLog.findUnique({
      where: { id },
      include: {
        initiatedBy: { select: { fullName: true } },
        customer: { select: { firstName: true, lastName: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true, modelYear: true } },
      },
    });
    if (!n) throw new NotFoundException('Notification not found');
    return n;
  }

  /** Retry a FAILED notification — a new auditable attempt, never a silent resend. */
  async retry(logId: string, userId: string) {
    this.enforceRateLimit(userId);
    const original = await this.prisma.notificationLog.findUnique({ where: { id: logId } });
    if (!original) throw new NotFoundException('Notification not found');
    if (original.status !== 'FAILED') {
      throw new BadRequestException('Only failed notifications can be retried.');
    }
    if (!original.body || (original.channel !== 'SMS' && original.channel !== 'EMAIL')) {
      throw new BadRequestException('This notification cannot be retried.');
    }

    let status: 'SENT' | 'FAILED' = 'SENT';
    let providerReference: string | undefined;
    let failureReason: string | undefined;
    try {
      const result = await this.provider.send({
        channel: original.channel,
        recipient: original.recipient,
        templateKey: original.templateKey,
        templateData: {},
        body: original.body,
        subject: original.subject ?? undefined,
      });
      status = result.success ? 'SENT' : 'FAILED';
      providerReference = result.providerReference;
      failureReason = result.failureReason;
    } catch (error) {
      status = 'FAILED';
      failureReason = error instanceof Error ? error.message : 'Provider send failed';
    }

    const attempt = await this.prisma.notificationLog.create({
      data: {
        entityType: original.entityType,
        entityId: original.entityId,
        channel: original.channel,
        templateKey: original.templateKey,
        templateVersion: original.templateVersion,
        recipient: original.recipient,
        intendedRecipient: original.intendedRecipient,
        testRouted: original.testRouted,
        simulated: original.simulated,
        status,
        providerReference,
        failureReason,
        reason: original.reason,
        subject: original.subject,
        body: original.body,
        generatedBody: original.generatedBody,
        customerId: original.customerId,
        vehicleId: original.vehicleId,
        initiatedByUserId: userId,
        sentAt: status === 'SENT' ? new Date() : undefined,
      },
    });

    await this.audit.log({
      actorUserId: userId,
      action: 'CUSTOMER_NOTIFICATION_RETRIED',
      entityType: 'NotificationLog',
      entityId: attempt.id,
      afterJson: { originalLogId: logId, outcome: status },
    });

    return { logId: attempt.id, status };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async getTemplate(reason: NotificationReason, channel: 'SMS' | 'EMAIL') {
    const row = await this.prisma.notificationTemplate.findFirst({
      where: { reason, channel },
    });
    if (row) return row;
    // Deployed-DB safety net: fall back to factory wording, then persist it.
    const dflt = DEFAULT_TEMPLATES.find((t) => t.reason === reason && t.channel === channel);
    if (!dflt) return null;
    try {
      return await this.prisma.notificationTemplate.create({
        data: {
          key: dflt.key,
          reason: dflt.reason as NotificationReason,
          channel: dflt.channel,
          name: dflt.name,
          subject: dflt.subject ?? null,
          body: dflt.body,
        },
      });
    } catch {
      // Raced with a concurrent create — read back.
      return this.prisma.notificationTemplate.findUnique({ where: { key: dflt.key } });
    }
  }

  private resolveRouting(
    channel: 'SMS' | 'EMAIL',
    intended: string,
  ): { to: string; testRouted: boolean; simulated: boolean } {
    const configured = channel === 'SMS' ? this.caps.smsConfigured : this.caps.emailConfigured;
    if (this.caps.mode === 'LIVE') {
      return { to: intended, testRouted: false, simulated: !configured };
    }
    // TEST mode
    const testTo = channel === 'SMS' ? this.caps.testSmsTo : this.caps.testEmailTo;
    if (testTo) {
      return { to: testTo, testRouted: true, simulated: !configured };
    }
    if (configured) {
      // A real provider in TEST mode with no test recipient must never reach a customer.
      throw new BadRequestException(
        `TEST mode is active but ${channel === 'SMS' ? 'NOTIFICATION_TEST_SMS_TO' : 'NOTIFICATION_TEST_EMAIL_TO'} is not configured. Configure a test recipient or set NOTIFICATION_MODE=LIVE.`,
      );
    }
    // Stub provider: nothing real is sent either way — record as simulated.
    return { to: intended, testRouted: false, simulated: true };
  }

  private isOverride(channel: 'SMS' | 'EMAIL', recipient: string, customer: { phone: string | null; email: string | null }): boolean {
    if (channel === 'SMS') {
      const norm = (v: string | null) => (v ? toE164Jamaica(v) : null);
      return norm(recipient) !== norm(customer.phone);
    }
    return recipient.toLowerCase() !== (customer.email ?? '').toLowerCase();
  }

  private enforceRateLimit(userId: string) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const stamps = (this.sendTimestamps.get(userId) ?? []).filter((t) => t > windowStart);
    if (stamps.length >= SEND_RATE_LIMIT) {
      throw new HttpException(
        'Too many notification sends — wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    stamps.push(now);
    this.sendTimestamps.set(userId, stamps);
  }

  /** Load customer/vehicle/visit context and build the template data set. */
  private async loadContext(input: ComposeInput) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: input.customerId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    let visit: { id: string; status: string; vehicleId: string } | null = null;
    let ticketNumber: string | null = null;
    if (input.serviceVisitId) {
      const v = await this.prisma.serviceVisit.findUnique({
        where: { id: input.serviceVisitId },
        select: {
          id: true,
          status: true,
          vehicleId: true,
          customerId: true,
          queueTicket: { select: { ticketNumber: true } },
        },
      });
      if (!v) throw new NotFoundException('Service visit not found');
      if (v.customerId !== customer.id) {
        throw new ForbiddenException('Visit does not belong to this customer.');
      }
      visit = { id: v.id, status: v.status, vehicleId: v.vehicleId };
      ticketNumber = v.queueTicket?.ticketNumber ?? null;
    }

    const vehicleId = input.vehicleId ?? visit?.vehicleId ?? null;
    const vehicle = vehicleId
      ? await this.prisma.vehicle.findUnique({
          where: { id: vehicleId },
          select: { id: true, customerId: true, plateNumber: true, make: true, model: true, modelYear: true, odometer: true },
        })
      : null;
    if (vehicle && vehicle.customerId !== customer.id) {
      throw new ForbiddenException('Vehicle does not belong to this customer.');
    }

    // Service-due context (recommended service, due date/mileage, last service).
    let serviceDue: {
      recommendationId: string;
      serviceTypeCode: string;
      serviceName: string | null;
      nextDueDate: Date | null;
      nextDueOdometer: number | null;
      lastServiceDate: Date | null;
      contactStatus: string;
      lastContactedAt: Date | null;
    } | null = null;
    if (input.recommendationId) {
      const rec = await this.prisma.maintenanceRecommendation.findUnique({
        where: { id: input.recommendationId },
        select: {
          id: true,
          vehicleId: true,
          serviceTypeCode: true,
          nextDueDate: true,
          nextDueOdometer: true,
          basisDate: true,
          contactStatus: true,
          lastContactedAt: true,
        },
      });
      if (rec) {
        if (vehicle && rec.vehicleId !== vehicle.id) {
          throw new ForbiddenException('Recommendation does not belong to this vehicle.');
        }
        const serviceType = await this.prisma.serviceType.findFirst({
          where: { code: rec.serviceTypeCode },
          select: { name: true },
        });
        serviceDue = {
          recommendationId: rec.id,
          serviceTypeCode: rec.serviceTypeCode,
          serviceName: serviceType?.name ?? null,
          nextDueDate: rec.nextDueDate,
          nextDueOdometer: rec.nextDueOdometer,
          lastServiceDate: rec.basisDate,
          contactStatus: rec.contactStatus,
          lastContactedAt: rec.lastContactedAt,
        };
      }
    }

    const fmtDate = (d: Date | null | undefined) =>
      d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;

    // serviceDueDetails: only lines with reliable data — nothing invented.
    const dueLines: string[] = [];
    if (serviceDue) {
      if (serviceDue.serviceName ?? serviceDue.serviceTypeCode) {
        dueLines.push(`Recommended service: ${serviceDue.serviceName ?? serviceDue.serviceTypeCode}`);
      }
      if (serviceDue.nextDueDate) dueLines.push(`Due date: ${fmtDate(serviceDue.nextDueDate)}`);
      if (serviceDue.nextDueOdometer != null) dueLines.push(`Due mileage: ${serviceDue.nextDueOdometer.toLocaleString()} miles`);
      if (vehicle?.odometer != null) dueLines.push(`Last recorded mileage: ${vehicle.odometer.toLocaleString()} miles`);
      if (serviceDue.lastServiceDate) dueLines.push(`Last service: ${fmtDate(serviceDue.lastServiceDate)}`);
    }

    const templateData: TemplateData = {
      customerFirstName: customer.firstName,
      customerFullName: `${customer.firstName} ${customer.lastName}`,
      vehicleYear: vehicle?.modelYear ?? null,
      vehicleMake: vehicle?.make ?? null,
      vehicleModel: vehicle?.model ?? null,
      vehicleDescription: vehicle ? buildVehicleDescription(vehicle) : null,
      registrationNumber: vehicle?.plateNumber ?? null,
      ticketDisplayNumber: ticketNumber,
      serviceDueDetails: dueLines.length ? dueLines.join('\n') : null,
      serviceDueDate: fmtDate(serviceDue?.nextDueDate),
      serviceDueMileage: serviceDue?.nextDueOdometer != null ? serviceDue.nextDueOdometer.toLocaleString() : null,
      lastServiceDate: fmtDate(serviceDue?.lastServiceDate),
      currentMileage: vehicle?.odometer != null ? vehicle.odometer.toLocaleString() : null,
      pickupDetails: null, // populated only when an approved operational value exists
      staffEditableUpdate: null, // the staff member writes this
      businessName: BUSINESS_NAME,
      siteName: BUSINESS_NAME,
    };

    return { customer, vehicle, visit, ticketNumber, serviceDue, templateData };
  }
}
