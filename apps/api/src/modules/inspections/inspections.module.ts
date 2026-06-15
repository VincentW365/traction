import { Module } from '@nestjs/common';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';
import { ServiceOrdersModule } from '../service-orders/service-orders.module';

/**
 * CR-2026-034 — Visual Inspection Form. PrismaService + the @Global AuditModule
 * (AuditService + StatusHistoryService) are injected without explicit imports.
 * ServiceOrdersModule (C-5) supplies ServiceOrdersService for approved→work-order.
 */
@Module({
  imports: [ServiceOrdersModule],
  controllers: [InspectionsController],
  providers: [InspectionsService],
  exports: [InspectionsService],
})
export class InspectionsModule {}
