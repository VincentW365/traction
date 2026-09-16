import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AppointmentsService } from './appointments.service';
import { CheckInService } from './check-in.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { CheckInDto } from './dto/check-in.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { SiteGuard } from '../../common/guards/site.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Appointments')
@Controller('appointments')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class AppointmentsController {
  constructor(
    private appointmentsService: AppointmentsService,
    private checkInService: CheckInService,
  ) {}

  @Post()
  @UseGuards(SiteGuard)
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'Create a new appointment' })
  async create(
    @Body() dto: CreateAppointmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.appointmentsService.create(dto, user.sub);
  }

  @Get()
  @RequirePermission(PERMISSIONS.APPOINTMENT_VIEW)
  @ApiOperation({ summary: 'List appointments for a site' })
  @ApiQuery({ name: 'siteId', required: true, description: 'Site ID to filter by' })
  @ApiQuery({ name: 'date', required: false, description: 'Filter by date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by appointment status' })
  @ApiQuery({ name: 'customerId', required: false, description: 'Filter by customer' })
  async findAll(
    @Query('siteId') siteId: string,
    @Query('date') date?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.appointmentsService.findBySite(siteId, { date, status, customerId });
  }

  // CR-2026-106 — declared BEFORE `:id` so these paths are not captured as an id.
  @Get('availability')
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'Staff availability — the same engine/rules as the public booking page, STAFF audience' })
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'serviceCodes', required: false, description: 'Comma-separated service codes (duration source)' })
  @ApiQuery({ name: 'from', required: false, description: 'First day, YYYY-MM-DD (site local)' })
  @ApiQuery({ name: 'days', required: false, description: 'Days to compute (max 31)' })
  @ApiQuery({ name: 'excludeAppointmentId', required: false, description: 'When rescheduling, ignore this appointment' })
  async availability(
    @Query('siteId') siteId: string,
    @Query('serviceCodes') serviceCodes?: string,
    @Query('from') from?: string,
    @Query('days') days?: string,
    @Query('excludeAppointmentId') excludeAppointmentId?: string,
  ) {
    if (!siteId) throw new BadRequestException('siteId is required');
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new BadRequestException('from must be YYYY-MM-DD');
    const d = days ? Number(days) : undefined;
    if (d !== undefined && (!Number.isInteger(d) || d < 1 || d > 31)) throw new BadRequestException('days must be 1–31');
    return this.appointmentsService.staffAvailability(siteId, (serviceCodes ?? '').split(',').map((c) => c.trim()).filter(Boolean), from, d, excludeAppointmentId || undefined);
  }

  @Get('booking-link')
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'The public booking link and the share message (WhatsApp/SMS hand-off)' })
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'phone', required: false, description: 'Customer mobile to address the WhatsApp/SMS deep link to' })
  async bookingLink(@Query('siteId') siteId: string, @Query('phone') phone?: string) {
    if (!siteId) throw new BadRequestException('siteId is required');
    return this.appointmentsService.bookingLink(siteId, phone || undefined);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.APPOINTMENT_VIEW)
  @ApiOperation({ summary: 'Get appointment by ID' })
  async findOne(@Param('id') id: string) {
    return this.appointmentsService.findById(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.APPOINTMENT_UPDATE)
  @ApiOperation({ summary: 'Update / reschedule an appointment' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.appointmentsService.update(id, dto, user.sub);
  }

  @Post(':id/confirm')
  @RequirePermission(PERMISSIONS.APPOINTMENT_CONFIRM)
  @ApiOperation({ summary: 'Confirm an appointment' })
  async confirm(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.appointmentsService.confirm(id, user.sub);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.APPOINTMENT_CANCEL)
  @ApiOperation({ summary: 'Cancel an appointment' })
  async cancel(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new BadRequestException('Cancellation reason is required');
    }
    return this.appointmentsService.cancel(id, reason.trim(), user.sub);
  }

  @Post(':id/check-in')
  @RequirePermission(PERMISSIONS.CHECKIN_PERFORM)
  @ApiOperation({
    summary: 'Check in a customer for an appointment',
    description:
      'Creates a ServiceVisit, generates a queue ticket, and transitions the appointment to CHECKED_IN.',
  })
  async checkIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CheckInDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const arrivalAt = dto.arrivalAt ? new Date(dto.arrivalAt) : undefined;
    return this.checkInService.checkIn(id, user.sub, arrivalAt, dto.notes, {
      mileageIn: dto.mileageIn,
      oilBrand: dto.oilBrand,
      oilGrade: dto.oilGrade,
      vehicleWeightClass: dto.vehicleWeightClass,
      vehicleServiceClass: dto.vehicleServiceClass,
      color: dto.color,
      mileageOverride: dto.mileageOverride,
      overrideReason: dto.overrideReason,
      notificationOptInSms: dto.notificationOptInSms,
      notificationOptInEmail: dto.notificationOptInEmail,
    });
  }
}
