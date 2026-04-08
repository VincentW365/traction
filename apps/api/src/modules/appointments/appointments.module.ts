import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { CheckInService } from './check-in.service';

@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService, CheckInService],
  exports: [AppointmentsService, CheckInService],
})
export class AppointmentsModule {}
