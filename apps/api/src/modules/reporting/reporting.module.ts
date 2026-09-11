import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';
import { ManagerDashboardController } from './manager-dashboard.controller';
import { ManagerDashboardService } from './manager-dashboard.service';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { JobTimesService } from './job-times.service';
import { AppointmentsReportService } from './appointments-report.service';
import { PerformanceReportService } from './performance-report.service';

@Module({
  controllers: [ReportingController, ManagerDashboardController, PerformanceController],
  providers: [
    ReportingService,
    ManagerDashboardService,
    PerformanceService,
    JobTimesService,
    AppointmentsReportService,
    PerformanceReportService,
  ],
})
export class ReportingModule {}
