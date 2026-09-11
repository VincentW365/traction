import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { CheckInService } from './check-in.service';

// CR-2026-105b — SchedulingModule so check-in ranks the new ticket immediately (QUE-002).
@Module({
  imports: [SchedulingModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, CheckInService],
  exports: [AppointmentsService, CheckInService],
})
export class AppointmentsModule {}
