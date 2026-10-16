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
  type NotificationCapabilities,
  type NotificationProvider,
} from './providers/notification-provider.interface';
import { deliveryDisplayState } from './notifications.service';
import { NotificationTemplateStore } from './templates/template-store.service';
import { EMAIL_ONLY_RELEASE, NO_EMAIL_ON_FILE } from './notification-messages';
import {
  decideConsent,
  MIN_OVERRIDE_REASON_LENGTH,
  PREFERENCE_LABELS,
  purposeForReason,
  type CommunicationPurposeName,
} from './consent-policy';
import { CommunicationPreferenceService } from './communication-preference.service';
import { NotificationRoutingService } from './notification-routing.service';
import { PERMISSIONS } from '../../common/constants/permissions';
import { publicUrl } from '../../common/helpers/public-url';
import {
  buildVehicleDescription,
  findDisallowedPlaceholders,
  findUnresolvedInFinal,
  isValidEmail,
  renderTemplate,
  TemplateData,
} from './templates/template-engine';

/**
 * CR-2026-096 — unified customer notifications.
 * CR-2026-112 — one channel: email.
 *
 * One pipeline for every staff-initiated customer message (service due, customer
 * action required, queue progress, vehicle ready, custom):
 * Generate → Review → Edit → Preview → Send → Track. Wording comes from
 * admin-editable NotificationTemplate rows; the exact text sent (after staff
 * edits) is snapshotted on NotificationLog so later template edits never rewrite
 * history.
 *
 * There is no channel choice to make: this release delivers by email. A send
 * asking for any other channel is REFUSED with a reason rather than recorded as
 * delivered (directive §9).
 */

const BUSINESS_NAME = "Bert's Service Centre";

// CR-2026-112 — re-exported so existing importers keep one obvious place to look.
export { NO_EMAIL_ON_FILE, EMAIL_ONLY_RELEASE };

export interface ComposeInput {
  reason: NotificationReason;
  customerId: string;
  vehicleId?: string;
  serviceVisitId?: string;
  recommendationId?: string;
}

export interface SendInput extends ComposeInput {
  /**
   * CR-2026-112 — accepted only so an out-of-date client asking for SMS is told
   * plainly that nothing was sent, instead of having the request quietly treated
   * as an email. Omit it; EMAIL is implied.
   */
  channels?: string[];
  email: { recipient: string; subject: string; body: string };
  /** Staff explicitly confirmed a repeat vehicle-ready notification. */
  confirmDuplicate?: boolean;
  /**
   * Staff explicitly chose to send despite the customer's recorded preference.
   * CR-2026-113 — only ever needed for a purpose that requires consent, only
   * permitted with `notify:consent_override`, and only with a reason.
   */
  overrideOptOut?: boolean;
  /** Why the preference is being overridden. Required with overrideOptOut. */
  overrideReason?: string;
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
    // CR-2026-112 — the shared template store: the composer and the automatic
    // flows now read the same manager-editable wording.
    private templates: NotificationTemplateStore,
    // CR-2026-114 — what the customer has actually told us (UNKNOWN / ALLOWED /
    // DECLINED), rather than a boolean that cannot tell the first two apart.
    private preferences: CommunicationPreferenceService,
    // CR-2026-117 — test vs live is read at send time, not frozen at boot.
    private routing: NotificationRoutingService,
  ) {}

  // -------------------------------------------------------------------------
  // Capabilities — what this deployment can actually deliver
  // -------------------------------------------------------------------------

  async capabilities() {
    // CR-2026-117 — the screen must show what WILL happen on the next send, not
    // what the environment said at boot.
    const effective = await this.routing.resolve(this.caps);
    return {
      emailConfigured: effective.emailConfigured,
      mode: effective.mode,
      testRoutingActive: effective.mode === 'TEST',
      testEmailTo: effective.testEmailTo ?? null,
      // Where the live/test answer came from, so nobody hunts for a setting that
      // is not in charge yet.
      modeSource: effective.source,
    };
  }

  // -------------------------------------------------------------------------
  // Templates — admin-editable wording
  // -------------------------------------------------------------------------

  /** Create-if-missing seeding; never overwrites an admin's edited wording. */
  async ensureDefaultTemplates(): Promise<number> {
    return this.templates.ensureDefaults();
  }

  /**
   * CR-2026-112 — EMAIL templates only. Legacy `_SMS` rows stay in the table so
   * historical messages remain explainable, but a manager is never shown wording
   * for a channel this release cannot send on.
   */
  async listTemplates() {
    await this.ensureDefaultTemplates();
    return this.prisma.notificationTemplate.findMany({
      where: { channel: 'EMAIL' },
      orderBy: [{ reason: 'asc' }, { key: 'asc' }],
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
    // CR-2026-112 — a legacy SMS row is history, not editable content.
    if (existing.channel !== 'EMAIL') {
      throw new BadRequestException(`${EMAIL_ONLY_RELEASE} This template is kept for historical messages and cannot be edited.`);
    }

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
    this.assertStatusLink(input.reason, context);
    const data = context.templateData;

    const emailTemplate = await this.getTemplate(input.reason);

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
    // CR-2026-112 — one channel, so one question: can we email this customer?
    // The composer shows the exact operational sentence when the answer is no.
    const emailValid = !!c.email && isValidEmail(c.email);

    // CR-2026-113 — what this message is FOR, and whether the customer's
    // optional-email preference stands in the way of it.
    const purpose = await this.purposeOf(input.reason);
    const preference = await this.preferences.statusFor(c.id, purpose as never);
    const consent = decideConsent({
      purpose,
      preference,
      purposesRequiringConsent: await this.templates.purposesRequiringConsent(),
    });

    return {
      reason: input.reason,
      customer: {
        id: c.id,
        name: `${c.firstName} ${c.lastName}`,
        phone: c.phone ?? null,
        email: c.email ?? null,
        allowEmail: c.notificationOptInEmail,
        emailValid,
        /** Present only when there is nothing to send to — the words staff read. */
        emailProblem: emailValid ? null : NO_EMAIL_ON_FILE,
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
      purpose,
      consent: {
        purpose,
        /** CR-2026-114 — the recorded state, and how to say it to a person. */
        preference,
        preferenceLabel: PREFERENCE_LABELS[preference],
        requiresConsent: consent.requiresConsent,
        allowed: consent.allowed,
        blockedReason: consent.blockedReason,
        /** What staff must supply to send anyway, when that is permitted at all. */
        overrideRequiresReason: true,
        minimumReasonLength: MIN_OVERRIDE_REASON_LENGTH,
      },
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

  /**
   * Send one reviewed customer email.
   *
   * CR-2026-112 — no channel loop and no channel argument: email is the channel.
   * A client that still asks for another one is refused outright, because a
   * message this deployment cannot deliver must never come back as sent.
   */
  async send(input: SendInput, userId: string, actorPermissions: string[] = []) {
    this.enforceRateLimit(userId);

    const asked = (input.channels ?? []).map((ch) => String(ch).toUpperCase());
    const unsupported = asked.filter((ch) => ch !== 'EMAIL');
    if (unsupported.length > 0) {
      throw new BadRequestException(
        `${EMAIL_ONLY_RELEASE} Nothing was sent for: ${unsupported.join(', ')}.`,
      );
    }
    if (!input.email) {
      throw new BadRequestException('No email content was provided.');
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
    this.assertStatusLink(input.reason, context);
    const c = context.customer;

    // Duplicate vehicle-ready guard — resend is allowed, but only deliberately.
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
          message: 'A ready-for-collection notification was already sent to this customer. Send another?',
          errors: {
            code: 'DUPLICATE_PICKUP',
            prior: { channel: prior.channel, sentAt: prior.sentAt ?? prior.createdAt, status: prior.status },
          },
        });
      }
    }

    // --- Recipient validation (send-to override allowed; master data untouched)
    const recipient = input.email.recipient?.trim();
    if (!recipient) {
      throw new BadRequestException(NO_EMAIL_ON_FILE);
    }
    if (!isValidEmail(recipient)) {
      throw new BadRequestException(
        `"${recipient}" is not a valid email address. Correct it before sending this notification.`,
      );
    }

    // --- CR-2026-113 — consent applies to the purposes the business says it
    //     applies to. An operational message about this customer's own booking
    //     or vehicle is not gated on a marketing preference, so the front desk
    //     never has to "override" anything to do its job. Optional outreach is
    //     gated, and sending anyway is an exceptional, permissioned, reasoned,
    //     audited act.
    const purpose = await this.purposeOf(input.reason);
    const preference = await this.preferences.statusFor(c.id, purpose as never);
    const consent = decideConsent({
      purpose,
      preference,
      purposesRequiringConsent: await this.templates.purposesRequiringConsent(),
    });

    const overrideRequested = !!input.overrideOptOut;
    const overrideReason = (input.overrideReason ?? '').trim();
    let consentOverridden = false;

    if (!consent.allowed) {
      if (!overrideRequested) {
        throw new ConflictException({
          message: consent.blockedReason ?? 'This customer has not opted in to optional emails.',
          errors: { code: 'CONSENT_REQUIRED', channel: 'EMAIL', purpose, preference },
        });
      }
      if (!actorPermissions.includes(PERMISSIONS.NOTIFY_CONSENT_OVERRIDE)) {
        throw new ForbiddenException(
          'Sending optional email to a customer who has not opted in needs a manager. Ask a manager to send it, or record the contact as a phone call instead.',
        );
      }
      if (overrideReason.length < MIN_OVERRIDE_REASON_LENGTH) {
        throw new BadRequestException(
          `Give a reason for sending despite the customer's recorded preference (at least ${MIN_OVERRIDE_REASON_LENGTH} characters). It is recorded against your name.`,
        );
      }
      consentOverridden = true;
    } else if (overrideRequested && !consent.requiresConsent) {
      // Nothing to override: this purpose does not depend on the preference.
      // Not an error — just never recorded as an override, because it was not one.
    }

    // --- Final content validation
    const body = input.email.body?.trim() ?? '';
    if (!body) throw new BadRequestException('The email message is empty.');
    const subject = input.email.subject?.trim() ?? '';
    if (!subject) throw new BadRequestException('The email subject is empty.');
    const unresolved = [...findUnresolvedInFinal(body), ...findUnresolvedInFinal(subject)];
    if (unresolved.length > 0) {
      throw new BadRequestException(
        `Message still contains unfilled placeholders: ${[...new Set(unresolved)].map((u) => `{{${u}}}`).join(', ')}. Fill or remove them before sending.`,
      );
    }

    // --- Template snapshot for audit (what was generated vs what was sent)
    const template = await this.getTemplate(input.reason);
    const generated = template ? renderTemplate(template.body, context.templateData).text : null;

    // --- Test routing (never concealed; intended recipient always retained)
    const routing = await this.resolveRouting(recipient);

    // --- Record first (DRAFT→SENDING semantics collapsed into one row)
    const log = await this.prisma.notificationLog.create({
      data: {
        entityType: context.visit ? 'ServiceVisit' : 'Customer',
        entityId: context.visit?.id ?? c.id,
        channel: 'EMAIL',
        templateKey: template?.key ?? `${input.reason}_EMAIL`,
        templateVersion: template?.version ?? 1,
        recipient: routing.to,
        intendedRecipient: routing.testRouted ? recipient : null,
        testRouted: routing.testRouted,
        simulated: routing.simulated,
        status: 'PENDING',
        reason: input.reason,
        subject,
        body,
        generatedBody: generated,
        purpose,
        consentOverridden,
        consentOverrideReason: consentOverridden ? overrideReason : null,
        customerId: c.id,
        vehicleId: context.vehicle?.id ?? null,
        initiatedByUserId: userId,
        clientRequestId: input.clientRequestId ? `${input.clientRequestId}:EMAIL` : null,
      },
    });

    // --- Deliver
    let status: 'SENT' | 'FAILED' = 'SENT';
    let providerReference: string | undefined;
    let failureReason: string | undefined;
    try {
      const result = await this.provider.send({
        channel: 'EMAIL',
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
        channel: 'EMAIL',
        intendedRecipient: recipient,
        actualRecipient: routing.to,
        testRouted: routing.testRouted,
        simulated: routing.simulated,
        recipientOverridden: recipient.toLowerCase() !== (c.email ?? '').trim().toLowerCase(),
        purpose,
        // CR-2026-114 — what was actually on record when the override happened.
        customerPreference: preference,
        consentOverridden,
        ...(consentOverridden ? { consentOverrideReason: overrideReason } : {}),
        edited: generated !== null && generated !== body,
        templateKey: template?.key,
        templateVersion: template?.version,
      },
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

    return {
      duplicate: false,
      // The array shape is kept so every existing caller and screen keeps working;
      // an email-only release simply always returns exactly one entry.
      sent: [
        {
          channel: 'EMAIL',
          status,
          // CR-2026-106 — the honest outcome for the screen: never 'Sent' when the
          // row was simulated or redirected, and the provider's reason on failure.
          displayState: deliveryDisplayState({ status, simulated: routing.simulated, testRouted: routing.testRouted }),
          failureReason: failureReason ?? null,
          recipient: routing.to,
          logId: log.id,
          testRouted: routing.testRouted,
          simulated: routing.simulated,
        },
      ],
    };
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
      // CR-2026-106 — what the screen must say (never "Sent" for a simulated or
      // test-redirected row; "Sent" = accepted by the provider, not delivered).
      displayState: deliveryDisplayState(n),
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
    // CR-2026-112 — a failed legacy SMS row stays in history and stays failed:
    // this release has no way to send it, so offering a retry would be a lie.
    if (!original.body || original.channel !== 'EMAIL') {
      throw new BadRequestException(
        original.channel === 'EMAIL'
          ? 'This notification cannot be retried.'
          : `${EMAIL_ONLY_RELEASE} This message was sent on another channel and cannot be retried.`,
      );
    }

    let status: 'SENT' | 'FAILED' = 'SENT';
    let providerReference: string | undefined;
    let failureReason: string | undefined;
    try {
      const result = await this.provider.send({
        channel: 'EMAIL',
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

  /**
   * CR-2026-113 — the purpose a reason is sent under: the template's setting if
   * it has one, else the factory classification.
   */
  private async purposeOf(reason: NotificationReason): Promise<CommunicationPurposeName> {
    try {
      return await this.templates.purposeFor(reason);
    } catch {
      return purposeForReason(reason);
    }
  }

  /** The one EMAIL template for a reason; self-heals from factory wording. */
  private async getTemplate(reason: NotificationReason) {
    return this.templates.resolve(reason);
  }

  private async resolveRouting(intended: string): Promise<{ to: string; testRouted: boolean; simulated: boolean }> {
    // CR-2026-117 — resolved per send, so Settings decides rather than the boot
    // environment. The mailbox itself is still env-only; see notification-routing.
    const effective = await this.routing.resolve(this.caps);
    const configured = effective.emailConfigured;
    if (effective.mode === 'LIVE') {
      return { to: intended, testRouted: false, simulated: !configured };
    }
    // TEST mode
    if (effective.testEmailTo) {
      return { to: effective.testEmailTo, testRouted: true, simulated: !configured };
    }
    if (configured) {
      // A real provider in TEST mode with no test recipient must never reach a customer.
      throw new BadRequestException(
        'Test routing is on but no test recipient is set, so this message has nowhere safe to go. ' +
          'Set a test recipient under Settings > Notifications, or turn live sending on there.',
      );
    }
    // Stub provider: nothing real is sent either way — record as simulated.
    return { to: intended, testRouted: false, simulated: true };
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
    // CR-2026-122 — the customer's status link, as the visit holds it. Null when
    // the visit has no token or the token has passed its window; the renderer
    // would drop the line, so `assertStatusLink` refuses the send instead.
    let statusLink: { url: string; expiresAt: Date; expiresText: string } | null = null;
    if (input.serviceVisitId) {
      const v = await this.prisma.serviceVisit.findUnique({
        where: { id: input.serviceVisitId },
        select: {
          id: true,
          status: true,
          vehicleId: true,
          customerId: true,
          customerStatusToken: true,
          tokenExpiresAt: true,
          // CR-2026-122 — the short customer number (CR-2026-089) is what the
          // customer was read at the desk; the long reference is for enquiries.
          queueTicket: { select: { ticketNumber: true, displayTicketNumber: true } },
          site: { select: { timezone: true } },
        },
      });
      if (!v) throw new NotFoundException('Service visit not found');
      if (v.customerId !== customer.id) {
        throw new ForbiddenException('Visit does not belong to this customer.');
      }
      visit = { id: v.id, status: v.status, vehicleId: v.vehicleId };
      ticketNumber = v.queueTicket?.displayTicketNumber ?? v.queueTicket?.ticketNumber ?? null;
      if (v.customerStatusToken && v.tokenExpiresAt && v.tokenExpiresAt.getTime() > Date.now()) {
        statusLink = {
          url: publicUrl(`/status/${v.customerStatusToken}`),
          expiresAt: v.tokenExpiresAt,
          expiresText: v.tokenExpiresAt.toLocaleString('en-US', {
            weekday: 'long',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: v.site?.timezone || undefined,
          }),
        };
      }
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
      // CR-2026-112 — what the customer must decide, and by when. Deliberately
      // empty: the advisor writes both in customer-facing words. The renderer
      // drops the labelled line, so the draft simply leaves them the space.
      actionRequired: null,
      actionNeededBy: null,
      businessName: BUSINESS_NAME,
      siteName: BUSINESS_NAME,
      // CR-2026-122 — filled only from a link that still works (see above).
      statusUrl: statusLink?.url ?? null,
      statusLinkExpires: statusLink?.expiresText ?? null,
    };

    return { customer, vehicle, visit, ticketNumber, serviceDue, templateData, statusLink };
  }

  /**
   * CR-2026-122 — a status-link email with no link in it would read as a
   * mistake to the customer, and the renderer drops a line whose value is
   * missing rather than sending "{{statusUrl}}". So the reason is refused, in
   * words the front desk can act on, whenever the visit has nothing to send.
   */
  private assertStatusLink(reason: NotificationReason, context: { visit: { id: string } | null; statusLink: unknown }) {
    if (reason !== 'STATUS_LINK') return;
    if (!context.visit) {
      throw new BadRequestException('A status link belongs to a visit. Open the ticket and send it from there.');
    }
    if (!context.statusLink) {
      throw new BadRequestException(
        "This visit's status link has expired, so there is nothing to send that would still work. " +
          'The link lasts 24 hours from check-in; for a longer visit, keep the customer updated from the ticket instead.',
      );
    }
  }
}
