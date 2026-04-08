import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class TechniciansService {
  constructor(private readonly prisma: PrismaService) {}

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
}
