import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { KpiService } from './kpi.service';
import { KpiReportingService } from './kpi-reporting.service';
import { KpiController } from './kpi.controller';

/**
 * CR-2026-088 — technician KPI.
 *
 * Exports KpiService so the service-orders module can hook the two lifecycle
 * moments that define the measurement (start of work, and first submit to QC)
 * without KPI logic leaking into the order state machine itself.
 */
@Module({
  imports: [AuditModule],
  controllers: [KpiController],
  providers: [KpiService, KpiReportingService],
  exports: [KpiService],
})
export class KpiModule {}
