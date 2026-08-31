import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
// Aliased: a local ./modules/schedule (resource schedule) already owns the name
// `ScheduleModule`. This is the NestJS task-scheduler that powers the appointment
// reminder cron (CR-2026-056).
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { SandboxModule } from './common/sandbox/sandbox.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { CustomersModule } from './modules/customers/customers.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { WalkInsModule } from './modules/walk-ins/walk-ins.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { QueueModule } from './modules/queue/queue.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ConfigManagementModule } from './modules/config/config.module';
import { AuditModule } from './modules/audit/audit.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { TechniciansModule } from './modules/technicians/technicians.module';
import { ServiceOrdersModule } from './modules/service-orders/service-orders.module';
import { KpiModule } from './modules/kpi/kpi.module';
// CR-2026-099 — Parts Requests retired at the owner's direction ("feature will
// not be needed"): parts arrive per-job, not through an internal request/
// reservation pipeline. The schema stays (the WAITING_PARTS workflow and the
// parts-readiness projection read it), only the API surface is withdrawn.
// Restore: uncomment this import + the PartsModule entry below.
// import { PartsModule } from './modules/parts/parts.module';
// CR-2026-040 — Transport (customer drop-off / request pick-up) archived: feature
// unregistered (not deleted). Module files kept under ./modules/transport for easy
// re-enable. Restore: uncomment this import + the TransportModule entry below.
// import { TransportModule } from './modules/transport/transport.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { StatusModule } from './modules/status/status.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { ScheduleHoldsModule } from './modules/schedule-holds/schedule-holds.module';
import { ComplaintsModule } from './modules/complaints/complaints.module';
import { InspectionsModule } from './modules/inspections/inspections.module';
import { VisitsModule } from './modules/visits/visits.module';
import { StaffModule } from './modules/staff/staff.module';
import { AvailabilityModule } from './modules/availability/availability.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    NestScheduleModule.forRoot(),
    PrismaModule,
    SandboxModule,
    AuthModule,
    HealthModule,
    CustomersModule,
    VehiclesModule,
    AppointmentsModule,
    WalkInsModule,
    SchedulingModule,
    QueueModule,
    NotificationsModule,
    ConfigManagementModule,
    AuditModule,
    ReportingModule,
    TechniciansModule,
    ServiceOrdersModule,
    // CR-2026-088 — technician KPI framework.
    KpiModule,
    // PartsModule,  // CR-2026-099 — retired (see import note above)
    // TransportModule,  // CR-2026-040 — archived (see import note above)
    MaintenanceModule,
    ResourcesModule,
    StatusModule,
    ScheduleModule,
    ScheduleHoldsModule,
    ComplaintsModule,
    InspectionsModule,
    VisitsModule,
    StaffModule,
    AvailabilityModule,
  ],
})
export class AppModule {}
