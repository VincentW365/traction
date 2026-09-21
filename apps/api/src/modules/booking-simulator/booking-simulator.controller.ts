import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BookingSimulatorService } from './booking-simulator.service';
import { ShadowComparisonService } from '../scheduling/availability/shadow-comparison.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';
import type { BookingAudience } from '../scheduling/availability/booking-availability.service';

/**
 * CR-2026-108 Stage 3 — Admin → Testing → Booking Simulator.
 *
 * Everything here returns the INTERNAL availability decision: capacity numbers,
 * rule values and (from Stage 5) resource facts. That is precisely what the public
 * booking API must never return, so this controller is permission-gated on
 * BOOKING_SIMULATE and mounted under /admin, never under /public.
 */
@ApiTags('Booking Simulator')
@Controller('admin/testing/booking')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class BookingSimulatorController {
  constructor(
    private readonly simulator: BookingSimulatorService,
    private readonly shadow: ShadowComparisonService,
  ) {}

  @Get('simulate')
  @RequirePermission(PERMISSIONS.BOOKING_SIMULATE)
  @ApiOperation({ summary: 'Run the production availability engine and return every slot decision with its reason' })
  simulate(
    @Query('serviceCodes') serviceCodes: string,
    @Query('from') from?: string,
    @Query('days') days?: string,
    @Query('audience') audience?: string,
    @Query('vehicleClass') vehicleClass?: string,
    @Query('record') record?: string,
  ) {
    return this.simulator.simulate({
      serviceCodes: (serviceCodes ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      from,
      days: days ? parseInt(days, 10) : undefined,
      audience: audience === 'STAFF' ? ('STAFF' as BookingAudience) : ('CUSTOMER' as BookingAudience),
      // Vehicle restrictions only bite once a class is known, so an unset filter
      // means "any vehicle" rather than a default guess at one.
      vehicleClass: vehicleClass === 'SEDAN_CLASS' || vehicleClass === 'SUV_CLASS' ? vehicleClass : null,
      // Opening the screen must not fill the evidence table with duplicates of
      // one question, so recording is opt-in.
      record: record === 'true',
    });
  }

  /**
   * CR-2026-108 §12 — what the recorded disagreements add up to.
   *
   * Read-only, and free of PII by construction of the table it reads.
   */
  @Get('shadow-findings')
  @RequirePermission(PERMISSIONS.BOOKING_SIMULATE)
  @ApiOperation({ summary: 'Summary of recorded FIXED vs RESOURCE_AWARE disagreements' })
  shadowFindings(@Query('siteId') siteId?: string, @Query('days') days?: string) {
    return this.shadow.findings(siteId, days ? parseInt(days, 10) : undefined);
  }

  @Post('uat-session')
  @RequirePermission(PERMISSIONS.BOOKING_SIMULATE)
  @ApiOperation({ summary: 'Start a short-lived UAT booking session and get a link that launches the real /book flow inside it' })
  startUatSession(@Body() body: { label?: string; notes?: string }, @CurrentUser() user: JwtPayload) {
    return this.simulator.startUatSession(user.sub, { label: body?.label, notes: body?.notes });
  }
}
