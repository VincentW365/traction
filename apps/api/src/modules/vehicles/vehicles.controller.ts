import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehicleSearchDto } from './dto/vehicle-search.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Vehicles')
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class VehiclesController {
  constructor(private vehiclesService: VehiclesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: 'Search vehicles by plate, Chassis Number/VIN, or customer name' })
  async search(@Query() dto: VehicleSearchDto) {
    return this.vehiclesService.search(dto.q, dto.includeHistorical === 'true');
  }

  @Post()
  @RequirePermission(PERMISSIONS.VEHICLE_CREATE)
  @ApiOperation({ summary: 'Create a new vehicle linked to a customer' })
  async create(@Body() dto: CreateVehicleDto) {
    return this.vehiclesService.create(dto);
  }

  @Get('by-customer/:customerId')
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: 'List all vehicles for a customer' })
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean })
  async findByCustomer(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.vehiclesService.findByCustomer(
      customerId,
      includeHistorical === 'true',
    );
  }

  /**
   * CR-2026-102 — the technician-safe read-only vehicle view.
   *
   * QUEUE_VIEW (every operational role) + a CONTEXTUAL gate in the service:
   * a technician reads only vehicles tied to their own assignments — never the
   * directory. Data visibility, administrative permission and navigation
   * permission are three different things; this endpoint grants the first only.
   */
  @Get(':id/operational')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({
    summary: 'Read-only operational vehicle view (technician: contextual — own assignments only)',
  })
  async operationalView(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.vehiclesService.getTechnicianView(id, { sub: user.sub, role: user.role });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: 'Get a vehicle by ID' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.findById(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.VEHICLE_UPDATE)
  @ApiOperation({ summary: 'Update a vehicle (partial)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.vehiclesService.update(id, dto);
  }
}
