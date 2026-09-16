import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { EtaService } from './eta/eta.service';
import { BookingAvailabilityService } from './availability/booking-availability.service';

// CR-2026-105b — EtaService is exported so every read surface (queue, resources,
// visits, status, service-orders) presents the ONE persisted estimate through the
// same rules; it never re-projects.
@Module({
  // CR-2026-106 — BookingAvailabilityService is the ONE availability/placement
  // engine for the public booking page, the staff wizard and staff create/reschedule.
  providers: [SchedulingService, EtaService, BookingAvailabilityService],
  exports: [SchedulingService, EtaService, BookingAvailabilityService],
})
export class SchedulingModule {}
