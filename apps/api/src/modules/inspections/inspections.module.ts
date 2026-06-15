import { Module } from '@nestjs/common';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';

/**
 * CR-2026-034 — Visual Inspection Form. PrismaService + the @Global AuditModule
 * (AuditService + StatusHistoryService) are injected without explicit imports.
 */
@Module({
  controllers: [InspectionsController],
  providers: [InspectionsService],
  exports: [InspectionsService],
})
export class InspectionsModule {}
