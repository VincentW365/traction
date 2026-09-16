import { Module } from '@nestjs/common';
import { BookingSimulatorModule } from '../booking-simulator/booking-simulator.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';

// CR-2026-105c — customer self-service booking. SchedulingModule supplies the
// EtaService whose capacity/default-duration rules the availability engine shares;
// Notifications and Audit are global.
@Module({
  imports: [SchedulingModule, BookingSimulatorModule],
  controllers: [PublicBookingController],
  providers: [PublicBookingService],
  exports: [PublicBookingService],
})
export class PublicBookingModule {}
