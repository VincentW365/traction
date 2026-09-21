import { Injectable, Logger } from '@nestjs/common';
import { NotificationReason } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { DEFAULT_TEMPLATES, defaultTemplateFor } from './default-templates';
import { renderTemplate, TemplateData } from './template-engine';

/**
 * CR-2026-112 — the ONE way to get customer-facing wording.
 *
 * Before this CR the staff composer read manager-editable templates from
 * `notification_templates` while the automatic flows (booking confirmation,
 * reschedule, cancellation, reminder) rendered their own wording in code. Two
 * sources of truth meant a manager could edit wording that half the system
 * ignored. Everything now resolves here.
 *
 * Self-healing on purpose: a deployment whose table has not been seeded — or a
 * reason added by a later release — falls back to the factory wording and
 * persists it, so a composer is never empty and an automatic email never goes
 * out blank. Manager edits are never overwritten (create-if-missing only).
 */
@Injectable()
export class NotificationTemplateStore {
  private readonly logger = new Logger(NotificationTemplateStore.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Create-if-missing seeding; never overwrites an admin's edited wording. */
  async ensureDefaults(): Promise<number> {
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
          subject: t.subject,
          body: t.body,
        },
      });
      created++;
    }
    return created;
  }

  /**
   * The live EMAIL template for a reason, healing a missing row from factory
   * wording. Returns null only for a reason that has no factory wording at all.
   */
  async resolve(reason: NotificationReason) {
    const row = await this.prisma.notificationTemplate.findFirst({
      where: { reason, channel: 'EMAIL' },
    });
    if (row) return row;

    const dflt = defaultTemplateFor(reason);
    if (!dflt) return null;
    try {
      this.logger.warn(`Notification template for ${reason} was missing — restored from factory wording`);
      return await this.prisma.notificationTemplate.create({
        data: {
          key: dflt.key,
          reason: dflt.reason as NotificationReason,
          channel: dflt.channel,
          name: dflt.name,
          subject: dflt.subject,
          body: dflt.body,
        },
      });
    } catch {
      // Raced with a concurrent create — read back.
      return this.prisma.notificationTemplate.findUnique({ where: { key: dflt.key } });
    }
  }

  /**
   * Rendered subject + body for a reason, or null when the reason has no
   * template (the caller then uses its own code fallback). A disabled template
   * also returns null: a manager switching a notification off must actually
   * switch it off, not have it quietly sent from factory wording.
   */
  async render(
    reason: NotificationReason,
    data: TemplateData,
  ): Promise<{ templateKey: string; templateVersion: number; subject: string; body: string } | null> {
    const template = await this.resolve(reason);
    if (!template || !template.enabled) return null;
    const subject = renderTemplate(template.subject ?? '', data).text;
    const body = renderTemplate(template.body, data).text;
    if (!body.trim()) return null;
    return {
      templateKey: template.key,
      templateVersion: template.version,
      subject: subject.trim(),
      body,
    };
  }
}
