import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PublicBookingService } from './public-booking.service';
import { BookingSimulatorService } from '../booking-simulator/booking-simulator.service';
import { readCookie, uatClearCookieOptions, uatCookieOptions, verifyUatSessionCookie, UAT_COOKIE_NAME } from '../booking-simulator/uat-session';
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
 */
@ApiTags('Public Booking')
@Controller('public/booking')
export class PublicBookingController {
  constructor(
    private readonly booking: PublicBookingService,
    private readonly simulator: BookingSimulatorService,
  ) {}

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
    return this.booking.availability(codes, q.from, q.days, this.clientKey(req));
  }

  /**
   * CR-2026-108 Stage 3 — exchange an administrator-issued LAUNCH token for an
   * HttpOnly session cookie, once. The privileged token then leaves the URL for
   * good: the page immediately navigates to a clean /book and everything after
   * runs on the cookie, which the browser cannot read back.
   *
   * A refusal is NEVER downgraded into a normal booking. A tester holding an
   * expired link must be told, not silently allowed to create a real customer and
   * send them a real message. The reason is logged, not returned — this endpoint
   * must not become an oracle for token validity.
   */
  @Post('uat/redeem')
  @ApiOperation({ summary: 'Redeem a UAT launch token for an HttpOnly session cookie (single use)' })
  async redeemUat(@Body() body: { token?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.simulator.redeemUatLaunchToken(body?.token);
    if (!result.ok) {
      throw new BadRequestException({
        code: 'UAT_SESSION_INVALID',
        message:
          'This test booking session is invalid or has expired. Return to the Booking Simulator and start a new UAT session.',
      });
    }
    res.cookie(UAT_COOKIE_NAME, result.cookieValue, uatCookieOptions(result.expiresAt));
    return { runLabel: result.context.runLabel, expiresAt: result.expiresAt.toISOString() };
  }

  @Post('confirm')
  @ApiOperation({ summary: 'Reserve the chosen slot (transactional; 409 SLOT_TAKEN if just claimed)' })
  async confirm(@Body() dto: ConfirmBookingDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // The UAT context, if any, is whatever the HttpOnly cookie proves — never a
    // value the page could set.
    const uat = verifyUatSessionCookie(readCookie(req.headers.cookie, UAT_COOKIE_NAME));
    const result = await this.booking.confirm(dto, this.clientKey(req), uat);
    if (uat) {
      // The session ends with the booking it was for. Left in place, the tester's
      // NEXT booking in this browser — a real one — would be silently tagged as
      // test data and the customer would never be told anything.
      res.clearCookie(UAT_COOKIE_NAME, uatClearCookieOptions());
    }
    return result;
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
