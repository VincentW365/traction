import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface RecordStatusChangeInput {
  entityType: string;
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  changedByUserId?: string;
  reasonCode?: string;
  notes?: string;
}

@Injectable()
export class StatusHistoryService {
  constructor(private prisma: PrismaService) {}

  async record(input: RecordStatusChangeInput) {
    return this.prisma.statusHistory.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        changedByUserId: input.changedByUserId,
        reasonCode: input.reasonCode,
        notes: input.notes,
      },
    });
  }

  async findByEntity(entityType: string, entityId: string) {
    return this.prisma.statusHistory.findMany({
      where: { entityType, entityId },
      orderBy: { changedAt: 'asc' },
      include: { changedBy: { select: { fullName: true, roleCode: true } } },
    });
  }
}
