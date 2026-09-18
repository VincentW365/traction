import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { EtaService } from './eta/eta.service';
import { BookingAvailabilityService } from './availability/booking-availability.service';
import { ResourceAvailabilityService } from './availability/resource-availability.service';
import { ShadowComparisonService } from './availability/shadow-comparison.service';
import { ResourceReservationService } from './availability/resource-reservation.service';

// CR-2026-105b — EtaService is exported so every read surface (queue, resources,
// visits, status, service-orders) presents the ONE persisted estimate through the
// same rules; it never re-projects.
@Module({
  // CR-2026-106 — BookingAvailabilityService is the ONE availability/placement
  // engine for the public booking page, the staff wizard and staff create/reschedule.
  //
  // CR-2026-108 Stage 5C — the resource-aware pair runs alongside it in SHADOW.
  // They are exported, not injected into the booking path: while
  // `booking_capacity_mode` is FIXED the resource model's opinion is recorded and
  // compared by admin tooling, and never consulted to answer a customer.
  providers: [SchedulingService, EtaService, BookingAvailabilityService, ResourceAvailabilityService, ShadowComparisonService, ResourceReservationService],
  exports: [SchedulingService, EtaService, BookingAvailabilityService, ResourceAvailabilityService, ShadowComparisonService, ResourceReservationService],
})
export class SchedulingModule {}
