import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ResourcesService } from './resources.service';
import { ResourceAdminService } from './resource-admin.service';
import { ResourcesController } from './resources.controller';

// CR-2026-105b — SchedulingModule supplies EtaService (dispatch estimates) and
// SchedulingService (republish estimates when a bay is claimed or released).
@Module({
  imports: [SchedulingModule],
  controllers: [ResourcesController],
  providers: [ResourcesService, ResourceAdminService],
  exports: [ResourcesService, ResourceAdminService],
})
export class ResourcesModule {}
