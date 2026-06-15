import { Module } from '@nestjs/common';
import { ComplaintsController } from './complaints.controller';
import { ComplaintsService } from './complaints.service';

/**
 * CR-2026-032 — Customer Complaints Log.
 * PrismaService and the @Global AuditModule (AuditService + StatusHistoryService)
 * are injected without explicit imports, matching the other feature modules.
 */
@Module({
  controllers: [ComplaintsController],
  providers: [ComplaintsService],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
