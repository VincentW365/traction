import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PublicBookingService } from './public-booking.service';
import {
  AvailabilityQueryDto,
  CancelBookingDto,
  ConfirmBookingDto,
  IdentifyDto,
  RescheduleBookingDto,
} from './dto/public-booking.dto';

/**
 * CR-2026-105c — public customer booking API. NO authentication: like the lobby
 * display and the customer status page, this controller carries no guards.
 * Every response is a masked, customer-safe projection (see the service), every
 * body/query is a validated DTO, and every write is rate-limited per client.
 *
 * CR-2026-121 — the UAT session exchange that lived here (CR-2026-108 Stage 3)
 * went with the Booking Simulator. A booking made on this page is a real
 * booking; test records are still recognised per record by their TestDataRun
 * tag, so the data-import sandbox keeps its safety net.
 */
@ApiTags('Public Booking')
@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  private clientKey(req: Request): string {
    const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    return fwd || req.ip || 'unknown';
  }

  @Get('site')
  @ApiOperation({ summary: 'Site name, opening context and booking rules for the public page (public)' })
  site() {
    return this.booking.getSiteInfo();
  }

  @Post('identify')
  @ApiOperation({ summary: 'Identify an existing customer by mobile + plate (public; never reveals which half mismatched)' })
  identify(@Body() dto: IdentifyDto, @Req() req: Request) {
    return this.booking.identify(dto, this.clientKey(req));
  }

  @Get('services')
  @ApiOperation({ summary: 'Services that can be booked online (customer-safe projection)' })
  services() {
    return this.booking.listServices();
  }

  @Get('availability')
  @ApiOperation({ summary: 'Next available appointment and per-day slots (public)' })
  availability(@Query() q: AvailabilityQueryDto, @Req() req: Request) {
    const codes = q.serviceCodes.split(',').map((c) => c.trim()).filter(Boolean);
    return this.booking.availability(codes, q.from, q.days, this.clientKey(req), q.vehicleId);
  }

  @Post('confirm')
  @ApiOperation({ summary: 'Reserve the chosen slot (transactional; 409 SLOT_TAKEN if just claimed)' })
  confirm(@Body() dto: ConfirmBookingDto, @Req() req: Request) {
    return this.booking.confirm(dto, this.clientKey(req));
  }

  @Get('manage/:token')
  @ApiOperation({ summary: 'View a booking via its manage link (public, token-gated)' })
  manage(@Param('token') token: string) {
    return this.booking.manageWithHistory(token);
  }

  @Post('manage/:token/cancel')
  @ApiOperation({ summary: 'Cancel a booking via its manage link (rule-gated)' })
  cancel(@Param('token') token: string, @Body() dto: CancelBookingDto, @Req() req: Request) {
    return this.booking.cancelByCustomer(token, dto.reason, this.clientKey(req));
  }

  @Post('manage/:token/reschedule')
  @ApiOperation({ summary: 'Move a booking via its manage link (rule-gated; re-checks capacity under lock)' })
  reschedule(@Param('token') token: string, @Body() dto: RescheduleBookingDto, @Req() req: Request) {
    return this.booking.rescheduleByCustomer(token, dto, this.clientKey(req));
  }
}
