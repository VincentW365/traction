import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BookingSimulatorService } from './booking-simulator.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
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
  constructor(private readonly simulator: BookingSimulatorService) {}

  @Get('simulate')
  @RequirePermission(PERMISSIONS.BOOKING_SIMULATE)
  @ApiOperation({ summary: 'Run the production availability engine and return every slot decision with its reason' })
  simulate(
    @Query('serviceCodes') serviceCodes: string,
    @Query('from') from?: string,
    @Query('days') days?: string,
    @Query('audience') audience?: string,
  ) {
    return this.simulator.simulate({
      serviceCodes: (serviceCodes ?? '').split(',').map((c) => c.trim()).filter(Boolean),
      from,
      days: days ? parseInt(days, 10) : undefined,
      audience: audience === 'STAFF' ? ('STAFF' as BookingAudience) : ('CUSTOMER' as BookingAudience),
    });
  }

  @Post('uat-session')
  @RequirePermission(PERMISSIONS.BOOKING_SIMULATE)
  @ApiOperation({ summary: 'Start a short-lived UAT booking session and get a link that launches the real /book flow inside it' })
  startUatSession(@Body() body: { label?: string; notes?: string }, @CurrentUser() user: JwtPayload) {
    return this.simulator.startUatSession(user.sub, { label: body?.label, notes: body?.notes });
  }
}
