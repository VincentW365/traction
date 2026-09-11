import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { CheckInService } from './check-in.service';
import { AppointmentsCronService } from './appointments-cron.service';

// CR-2026-105b — SchedulingModule so check-in ranks the new ticket immediately (QUE-002)
// and the staff create path can see workshop capacity (CR-2026-105c).
// CR-2026-105c — hourly auto-MISSED sweep (rule-gated, off by default).
@Module({
  imports: [SchedulingModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, CheckInService, AppointmentsCronService],
  exports: [AppointmentsService, CheckInService],
})
export class AppointmentsModule {}
