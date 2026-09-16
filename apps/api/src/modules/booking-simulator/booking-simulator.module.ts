import { Module } from '@nestjs/common';
import { BookingSimulatorController } from './booking-simulator.controller';
import { BookingSimulatorService } from './booking-simulator.service';
import { SchedulingModule } from '../scheduling/scheduling.module';

/**
 * CR-2026-108 Stage 3 — the simulator deliberately owns no availability logic of
 * its own. It imports SchedulingModule and asks BookingAvailabilityService the
 * same question the public page asks, so what an analyst reads here is what a
 * customer actually got. AuditService arrives via the @Global AuditModule.
 */
@Module({
  imports: [SchedulingModule],
  controllers: [BookingSimulatorController],
  providers: [BookingSimulatorService],
  exports: [BookingSimulatorService],
})
export class BookingSimulatorModule {}
