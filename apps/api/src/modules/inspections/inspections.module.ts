import { Module } from '@nestjs/common';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';
import { InspectionPhotosService } from './inspection-photos.service';
import { InspectionPhotoStorage } from './storage/inspection-photo-storage';
import { ServiceOrdersModule } from '../service-orders/service-orders.module';

/**
 * CR-2026-034 — Visual Inspection Form. PrismaService + the @Global AuditModule
 * (AuditService + StatusHistoryService) are injected without explicit imports.
 * ServiceOrdersModule (C-5) supplies ServiceOrdersService for approved→work-order.
 *
 * CR-2026-093 — photographs get their own service and a storage boundary, so the
 * inspection domain never touches a filesystem or an object-store SDK directly.
 */
@Module({
  imports: [ServiceOrdersModule],
  controllers: [InspectionsController],
  providers: [InspectionsService, InspectionPhotosService, InspectionPhotoStorage],
  exports: [InspectionsService, InspectionPhotosService],
})
export class InspectionsModule {}
