import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class ExternalRefService {
  constructor(private prisma: PrismaService) {}

  async linkExternal(
    system: 'AUTOMATE' | 'SAGE',
    entityType: string,
    entityId: string,
    externalId: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.prisma.externalSystemRef.upsert({
      where: {
        system_entityType_entityId: { system, entityType, entityId },
      },
      update: {
        externalId,
        syncStatus: 'SYNCED',
        lastSyncAt: new Date(),
        lastSyncError: null,
        metadata: metadata ? (metadata as any) : undefined,
      },
      create: {
        system,
        entityType,
        entityId,
        externalId,
        syncStatus: 'SYNCED',
        lastSyncAt: new Date(),
        metadata: metadata ? (metadata as any) : undefined,
      },
    });
  }

  async getRefsForEntity(entityId: string) {
    return this.prisma.externalSystemRef.findMany({
      where: { entityId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateSyncStatus(id: string, status: string, error?: string) {
    const ref = await this.prisma.externalSystemRef.findUnique({ where: { id } });
    if (!ref) throw new NotFoundException(`ExternalSystemRef ${id} not found`);

    return this.prisma.externalSystemRef.update({
      where: { id },
      data: {
        syncStatus: status,
        lastSyncAt: new Date(),
        lastSyncError: error ?? null,
      },
    });
  }
}
