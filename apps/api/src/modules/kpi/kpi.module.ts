import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { KpiService } from './kpi.service';
import { KpiReportingService } from './kpi-reporting.service';
import { KpiMappingService } from './kpi-mapping.service';
import { WorkSegmentService } from './work-segment.service';
import { KpiController } from './kpi.controller';

/**
 * CR-2026-088 / CR-2026-090 — technician KPI.
 *
 * Exports KpiService and WorkSegmentService so the service-orders module can hook the
 * lifecycle moments that define the measurement — start of work, pause, resume,
 * reassignment, and first submit to QC — without KPI logic leaking into the order
 * state machine itself.
 */
@Module({
  imports: [AuditModule],
  controllers: [KpiController],
  providers: [KpiService, KpiReportingService, KpiMappingService, WorkSegmentService],
  exports: [KpiService, WorkSegmentService],
})
export class KpiModule {}
