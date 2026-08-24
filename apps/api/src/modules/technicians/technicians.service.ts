import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AddSkillDto } from './dto/add-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';
import { matchResources } from '../scheduling/engine/resource.matcher';
import type { VisitCandidate, DetailedSiteResources } from '../scheduling/engine/types';

const OPEN_ASSIGNMENT_STATUSES = ['ASSIGNED', 'IN_PROGRESS'];

@Injectable()
export class TechniciansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * List all active technicians for a site, including skills and user account name.
   */
  async findBySite(siteId: string) {
    return this.prisma.technician.findMany({
      where: {
        homeSiteId: siteId,
        status: 'ACTIVE',
      },
      include: {
        userAccount: {
          select: { id: true, fullName: true, email: true },
        },
        skills: {
          select: {
            id: true,
            skillCode: true,
            proficiencyLevel: true,
            isPrimary: true,
          },
        },
      },
      orderBy: { employeeCode: 'asc' },
    });
  }

  /**
   * Single technician by ID with skills and user account.
   */
  async findById(id: string) {
    const technician = await this.prisma.technician.findUnique({
      where: { id },
      include: {
        userAccount: {
          select: { id: true, fullName: true, email: true },
        },
        skills: {
          select: {
            id: true,
            skillCode: true,
            proficiencyLevel: true,
            isPrimary: true,
          },
        },
      },
    });

    if (!technician) {
      throw new NotFoundException(`Technician ${id} not found`);
    }

    return technician;
  }

  /**
   * Find technicians who have ALL required skills, plus compatible bays at the site.
   * Used for technician/bay assignment candidate matching.
   */
  async findAvailableForService(
    siteId: string,
    requiredSkillCodes: string[],
    requiredBayTypes: string[],
  ) {
    // Find active technicians at the site who have every required skill
    const technicians = await this.prisma.technician.findMany({
      where: {
        homeSiteId: siteId,
        status: 'ACTIVE',
      },
      include: {
        userAccount: {
          select: { id: true, fullName: true },
        },
        skills: {
          select: {
            skillCode: true,
            proficiencyLevel: true,
            isPrimary: true,
          },
        },
      },
    });

    // Filter to only technicians who possess ALL required skill codes
    const qualified = technicians.filter((tech) => {
      const techSkillCodes = tech.skills.map((s) => s.skillCode);
      return requiredSkillCodes.every((code) => techSkillCodes.includes(code));
    });

    // Find active bays at the site matching any of the required bay types
    const bays = await this.prisma.workBay.findMany({
      where: {
        siteId,
        status: 'ACTIVE',
        ...(requiredBayTypes.length > 0
          ? { bayType: { in: requiredBayTypes } }
          : {}),
      },
      select: {
        id: true,
        code: true,
        bayType: true,
      },
      orderBy: { code: 'asc' },
    });

    return { technicians: qualified, bays };
  }

  /**
   * Get the currently active assignment for a technician.
   * Used for double-booking checks before new assignment.
   * Returns null if the technician has no active assignment.
   */
  async getActiveAssignment(technicianId: string) {
    return this.prisma.technicianAssignment.findFirst({
      where: {
        technicianId,
        status: { in: ['ASSIGNED', 'ACTIVE'] },
        startedAt: { not: null },
        endedAt: null,
      },
      include: {
        serviceOrder: {
          select: {
            id: true,
            serviceVisitId: true,
            status: true,
          },
        },
        bay: {
          select: {
            id: true,
            code: true,
            bayType: true,
          },
        },
      },
    });
  }

  /**
   * CR-2026-035 (Phase B) — ranked "recommended technicians" for a service order.
   * Read-only / advisory: reuses the scheduling-engine matcher for skill candidacy,
   * then adds current load + today's shift availability + a transparent score. Does
   * NOT assign anything — staff still confirm via the existing assign endpoint, which
   * remains the authoritative skill/bay/double-booking gate.
   */
  async getRecommendedTechnicians(serviceOrderId: string, now: Date = new Date()) {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      include: {
        items: { include: { serviceType: { select: { requiredSkillCode: true, requiredBayType: true } } } },
        serviceVisit: { select: { siteId: true } },
      },
    });
    if (!order) throw new NotFoundException(`Service order ${serviceOrderId} not found`);
    const siteId = order.serviceVisit.siteId;

    const requiredSkillCodes = [...new Set(order.items.map((i) => i.serviceType.requiredSkillCode).filter((c): c is string => !!c))];
    const requiredBayTypes = [...new Set(order.items.map((i) => i.serviceType.requiredBayType).filter((c): c is string => !!c))];

    // Today's date (UTC midnight) for the @db.Date shift-availability lookup.
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const technicians = await this.prisma.technician.findMany({
      where: { homeSiteId: siteId, status: 'ACTIVE' },
      include: {
        userAccount: { select: { fullName: true } },
        skills: { select: { skillCode: true } },
        assignments: {
          where: { status: { in: OPEN_ASSIGNMENT_STATUSES }, endedAt: null },
          // CR-2026-098b — the order status decides how much an assignment weighs:
          // a job parked in WAITING_PARTS is not the same load as active work.
          select: { id: true, serviceOrder: { select: { status: true } } },
        },
        availability: { where: { date: today }, select: { status: true, shiftStart: true, shiftEnd: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });

    const bays = await this.prisma.workBay.findMany({
      where: { siteId, status: 'ACTIVE' },
      select: { id: true, code: true, bayType: true },
      orderBy: { code: 'asc' },
    });

    // Reuse the scheduling-engine matcher for skill candidacy (ALL required skills).
    const resources = {
      technicians: technicians.map((t) => ({ id: t.id, skillCodes: t.skills.map((s) => s.skillCode) })),
      bays: bays.map((b) => ({ id: b.id, bayType: b.bayType })),
    } as unknown as DetailedSiteResources;
    const { candidateTechnicianIds } = matchResources(
      { requiredSkillCodes, requiredBayTypes } as unknown as VisitCandidate,
      resources,
    );
    const candidates = new Set(candidateTechnicianIds);

    // Any active bay works when the order needs no specific bay type.
    const compatibleBays = requiredBayTypes.length === 0 ? bays : bays.filter((b) => requiredBayTypes.includes(b.bayType));

    const ranked = technicians
      .filter((t) => candidates.has(t.id))
      .map((t) => {
        const openAssignments = t.assignments.length;
        // CR-2026-098b — split load by what the underlying job is doing. A
        // technician whose only job sits in WAITING_PARTS/WAITING_CUSTOMER/PAUSED
        // is standing at an idle bench: dispatchable now, still responsible for
        // resuming the held job later. Active work carries the full penalty;
        // held work a reduced one.
        const HELD = new Set(['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER']);
        const activeAssignments = t.assignments.filter((a) => !HELD.has(a.serviceOrder.status)).length;
        const heldAssignments = openAssignments - activeAssignments;
        const shiftStatus = t.availability[0]?.status ?? 'NOT_SCHEDULED';
        const availabilityBonus =
          shiftStatus === 'AVAILABLE' ? 50 : shiftStatus === 'ON_BREAK' ? 10 : shiftStatus === 'NOT_SCHEDULED' ? 0 : -50;
        const loadPenalty = activeAssignments * 40 + heldAssignments * 15;
        const skillBreadthBonus = t.skills.length;
        const score = 100 + availabilityBonus - loadPenalty + skillBreadthBonus;
        return {
          technicianId: t.id,
          employeeCode: t.employeeCode,
          fullName: t.userAccount.fullName,
          skillCodes: t.skills.map((s) => s.skillCode),
          openAssignments,
          activeAssignments,
          heldAssignments,
          shiftStatus,
          shift: t.availability[0] ? { start: t.availability[0].shiftStart, end: t.availability[0].shiftEnd } : null,
          available: activeAssignments === 0 && (shiftStatus === 'AVAILABLE' || shiftStatus === 'NOT_SCHEDULED'),
          score,
          scoreBreakdown: { base: 100, availabilityBonus, loadPenalty: -loadPenalty, skillBreadthBonus },
        };
      })
      .sort((a, b) => b.score - a.score || a.openAssignments - b.openAssignments || a.employeeCode.localeCompare(b.employeeCode));

    return { serviceOrderId, siteId, requiredSkillCodes, requiredBayTypes, compatibleBays, technicians: ranked };
  }

  // --- Skill CRUD ---

  async addSkill(technicianId: string, dto: AddSkillDto, actorUserId: string) {
    // Verify technician exists
    await this.findById(technicianId);

    // Check for duplicate
    const existing = await this.prisma.technicianSkill.findUnique({
      where: { technicianId_skillCode: { technicianId, skillCode: dto.skillCode } },
    });
    if (existing) {
      throw new ConflictException(`Technician already has skill ${dto.skillCode}`);
    }

    const skill = await this.prisma.technicianSkill.create({
      data: {
        technicianId,
        skillCode: dto.skillCode,
        proficiencyLevel: dto.proficiencyLevel ?? 1,
        isPrimary: dto.isPrimary ?? false,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'SKILL_ADD',
      entityType: 'TechnicianSkill',
      entityId: skill.id,
      afterJson: { technicianId, skillCode: dto.skillCode, proficiencyLevel: dto.proficiencyLevel },
    });

    return skill;
  }

  async updateSkill(technicianId: string, skillId: string, dto: UpdateSkillDto, actorUserId: string) {
    const skill = await this.prisma.technicianSkill.findFirst({
      where: { id: skillId, technicianId },
    });
    if (!skill) {
      throw new NotFoundException(`Skill ${skillId} not found for technician ${technicianId}`);
    }

    const data: any = {};
    if (dto.proficiencyLevel !== undefined) data.proficiencyLevel = dto.proficiencyLevel;
    if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;

    const updated = await this.prisma.technicianSkill.update({
      where: { id: skillId },
      data,
    });

    await this.audit.log({
      actorUserId,
      action: 'SKILL_UPDATE',
      entityType: 'TechnicianSkill',
      entityId: skillId,
      beforeJson: { proficiencyLevel: skill.proficiencyLevel, isPrimary: skill.isPrimary },
      afterJson: data,
    });

    return updated;
  }

  async removeSkill(technicianId: string, skillId: string, actorUserId: string) {
    const skill = await this.prisma.technicianSkill.findFirst({
      where: { id: skillId, technicianId },
    });
    if (!skill) {
      throw new NotFoundException(`Skill ${skillId} not found for technician ${technicianId}`);
    }

    await this.prisma.technicianSkill.delete({
      where: { id: skillId },
    });

    await this.audit.log({
      actorUserId,
      action: 'SKILL_REMOVE',
      entityType: 'TechnicianSkill',
      entityId: skillId,
      beforeJson: { technicianId, skillCode: skill.skillCode },
    });

    return { deleted: true };
  }
}
