import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { LinkTechnicianDto } from './dto/link-technician.dto';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(filters: {
    siteId?: string;
    roleCode?: string;
    status?: string;
    search?: string;
  }) {
    const where: any = {};

    if (filters.siteId) where.siteId = filters.siteId;
    if (filters.roleCode) where.roleCode = filters.roleCode;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { fullName: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.userAccount.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        email: true,
        roleCode: true,
        status: true,
        siteId: true,
        createdAt: true,
        technician: {
          select: {
            id: true,
            employeeCode: true,
            status: true,
            // CR-2026-087 - senior technicians may be assigned a quality check.
            isSenior: true,
          },
        },
      },
      orderBy: { fullName: 'asc' },
    });
  }

  async findById(id: string) {
    const user = await this.prisma.userAccount.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        roleCode: true,
        status: true,
        siteId: true,
        createdAt: true,
        updatedAt: true,
        technician: {
          select: {
            id: true,
            employeeCode: true,
            status: true,
            // CR-2026-087 - senior technicians may be assigned a quality check.
            isSenior: true,
            homeSiteId: true,
            skills: {
              select: {
                id: true,
                skillCode: true,
                proficiencyLevel: true,
                isPrimary: true,
              },
              orderBy: { skillCode: 'asc' },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`Staff member ${id} not found`);
    }

    return user;
  }

  async create(dto: CreateStaffDto, actorUserId: string, actorSiteId: string | null) {
    // Check for duplicate email
    if (dto.email) {
      const existing = await this.prisma.userAccount.findFirst({
        where: { email: dto.email },
      });
      if (existing) {
        throw new ConflictException(`Email ${dto.email} is already in use`);
      }
    }

    const passwordHash = await bcrypt.hash(dto.temporaryPassword, 12);
    const siteId = dto.siteId ?? actorSiteId;

    const user = await this.prisma.userAccount.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        roleCode: dto.roleCode,
        passwordHash,
        siteId,
        status: 'ACTIVE',
      },
    });

    // Auto-create technician record if role is TECHNICIAN and employeeCode provided
    if (dto.roleCode === 'TECHNICIAN' && dto.employeeCode) {
      await this.prisma.technician.create({
        data: {
          userAccountId: user.id,
          employeeCode: dto.employeeCode,
          homeSiteId: siteId,
          status: 'ACTIVE',
        },
      });
    }

    await this.audit.log({
      actorUserId,
      action: 'STAFF_CREATE',
      entityType: 'UserAccount',
      entityId: user.id,
      afterJson: { fullName: dto.fullName, roleCode: dto.roleCode, email: dto.email },
    });

    return this.findById(user.id);
  }

  async update(id: string, dto: UpdateStaffDto, actorUserId: string) {
    const existing = await this.findById(id);

    const data: any = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.roleCode !== undefined) data.roleCode = dto.roleCode;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    await this.prisma.userAccount.update({
      where: { id },
      data,
    });

    await this.audit.log({
      actorUserId,
      action: 'STAFF_UPDATE',
      entityType: 'UserAccount',
      entityId: id,
      beforeJson: { fullName: existing.fullName, roleCode: existing.roleCode, email: existing.email },
      afterJson: data,
    });

    return this.findById(id);
  }

  async deactivate(id: string, actorUserId: string) {
    const existing = await this.findById(id);
    if (existing.status === 'INACTIVE') {
      throw new BadRequestException('Staff member is already inactive');
    }

    await this.prisma.userAccount.update({
      where: { id },
      data: { status: 'INACTIVE' },
    });

    // Also deactivate linked technician
    if (existing.technician) {
      await this.prisma.technician.update({
        where: { id: existing.technician.id },
        data: { status: 'INACTIVE' },
      });
    }

    await this.audit.log({
      actorUserId,
      action: 'STAFF_DEACTIVATE',
      entityType: 'UserAccount',
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: 'INACTIVE' },
    });

    return this.findById(id);
  }

  async reactivate(id: string, actorUserId: string) {
    const existing = await this.findById(id);
    if (existing.status === 'ACTIVE') {
      throw new BadRequestException('Staff member is already active');
    }

    await this.prisma.userAccount.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });

    // Also reactivate linked technician
    if (existing.technician) {
      await this.prisma.technician.update({
        where: { id: existing.technician.id },
        data: { status: 'ACTIVE' },
      });
    }

    await this.audit.log({
      actorUserId,
      action: 'STAFF_REACTIVATE',
      entityType: 'UserAccount',
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: 'ACTIVE' },
    });

    return this.findById(id);
  }

  /**
   * CR-2026-095 — delete a DEACTIVATED staff member from the roster.
   *
   * The line this draws: a person's presence in the shop's OPERATIONAL RECORD is not
   * deletable. Someone who worked jobs, appears in KPI snapshots, or took actions
   * that were audited stays — deactivated, off every roster and selector, but
   * resolvable wherever history points at them. Deletion is for the other case: an
   * account created in error, a duplicate, a hire who never started. Those may go
   * entirely.
   *
   * Deactivation first is mandatory. It proves the removal was considered rather
   * than a slip on an active employee, and it means every selector already stopped
   * offering the person before the row disappears.
   */
  async remove(id: string, actorUserId: string) {
    const existing = await this.findById(id);
    if (existing.status !== 'INACTIVE') {
      throw new BadRequestException(
        'Only a deactivated staff member can be deleted. Deactivate them first.',
      );
    }

    const technicianId = existing.technician?.id ?? null;

    // Operational references. Any one of these makes the person part of the shop's
    // history, and history keeps its people.
    const blocks: string[] = [];
    if (technicianId) {
      const [assignments, segments, delays, occupancies, qcOrders] = await Promise.all([
        this.prisma.technicianAssignment.count({ where: { technicianId } }),
        this.prisma.technicianWorkSegment.count({ where: { technicianId } }),
        this.prisma.kpiDelayEvent.count({ where: { technicianId } }),
        this.prisma.resourceOccupancy.count({ where: { technicianId } }),
        this.prisma.serviceOrder.count({ where: { qcAssignedTechnicianId: technicianId } }),
      ]);
      if (assignments) blocks.push(`${assignments} work assignment(s)`);
      if (segments) blocks.push(`${segments} recorded work segment(s)`);
      if (delays) blocks.push(`${delays} KPI delay record(s)`);
      if (occupancies) blocks.push(`${occupancies} bay occupancy record(s)`);
      if (qcOrders) blocks.push(`${qcOrders} quality-check assignment(s)`);
    }
    const auditActions = await this.prisma.auditLog.count({ where: { actorUserId: id } });
    if (auditActions) blocks.push(`${auditActions} audited action(s)`);

    if (blocks.length > 0) {
      throw new BadRequestException(
        `${existing.fullName} has operational history (${blocks.join(', ')}) and cannot be deleted — ` +
          'they stay deactivated so that history keeps resolving. Deletion is only for accounts that were never used.',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (technicianId) {
          await tx.technicianSkill.deleteMany({ where: { technicianId } });
          await tx.mechanicDayAvailability.deleteMany({ where: { technicianId } });
          await tx.technician.delete({ where: { id: technicianId } });
        }
        await tx.userAccount.delete({ where: { id } });
      });
    } catch (e) {
      // A foreign key this method did not enumerate. Refuse rather than half-delete:
      // the constraint is telling us this person IS referenced somewhere.
      if ((e as { code?: string }).code === 'P2003') {
        throw new BadRequestException(
          `${existing.fullName} is still referenced by other records and cannot be deleted. They remain deactivated.`,
        );
      }
      throw e;
    }

    await this.audit.log({
      actorUserId,
      action: 'STAFF_DELETE',
      entityType: 'UserAccount',
      entityId: id,
      beforeJson: {
        fullName: existing.fullName,
        email: existing.email,
        roleCode: existing.roleCode,
        technicianId,
      },
      notes: 'Hard delete of a never-used, deactivated staff account',
    });
    return { deleted: true };
  }

  async linkTechnician(userId: string, dto: LinkTechnicianDto, actorUserId: string) {
    const user = await this.findById(userId);

    if (user.technician) {
      throw new ConflictException('User is already linked to a technician profile');
    }

    // Check employee code uniqueness
    const existing = await this.prisma.technician.findUnique({
      where: { employeeCode: dto.employeeCode },
    });
    if (existing) {
      throw new ConflictException(`Employee code ${dto.employeeCode} is already in use`);
    }

    const technician = await this.prisma.technician.create({
      data: {
        userAccountId: userId,
        employeeCode: dto.employeeCode,
        homeSiteId: user.siteId,
        status: 'ACTIVE',
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'TECHNICIAN_LINK',
      entityType: 'Technician',
      entityId: technician.id,
      afterJson: { userAccountId: userId, employeeCode: dto.employeeCode },
    });

    return this.findById(userId);
  }

  async getTechnicianProfile(userId: string) {
    const user = await this.findById(userId);
    if (!user.technician) {
      throw new NotFoundException('No technician profile linked to this user');
    }
    return user.technician;
  }

  /**
   * CR-2026-087 — mark a technician senior, or clear it.
   *
   * Audited because it changes who is allowed to sign off someone else's work,
   * which is a control, not a preference.
   */
  async setSeniority(userId: string, isSenior: boolean, actorUserId: string) {
    const user = await this.findById(userId);
    if (!user.technician) {
      throw new NotFoundException('No technician profile linked to this user');
    }
    if (user.technician.isSenior === isSenior) {
      return user.technician; // No-op; nothing to record.
    }

    const updated = await this.prisma.technician.update({
      where: { id: user.technician.id },
      data: { isSenior },
      select: { id: true, employeeCode: true, status: true, isSenior: true },
    });

    await this.audit.log({
      actorUserId,
      action: 'TECHNICIAN_SENIORITY_CHANGE',
      entityType: 'Technician',
      entityId: updated.id,
      beforeJson: { isSenior: user.technician.isSenior },
      afterJson: { isSenior },
      reasonCode: 'TECHNICIAN_SENIORITY_CHANGE',
      notes: `${user.fullName} ${isSenior ? 'marked as' : 'removed from'} senior technician`,
    });

    return updated;
  }
}
