import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { EtaService } from './eta/eta.service';

// CR-2026-105b — EtaService is exported so every read surface (queue, resources,
// visits, status, service-orders) presents the ONE persisted estimate through the
// same rules; it never re-projects.
@Module({
  providers: [SchedulingService, EtaService],
  exports: [SchedulingService, EtaService],
})
export class SchedulingModule {}
