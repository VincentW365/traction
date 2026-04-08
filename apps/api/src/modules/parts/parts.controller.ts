import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PartsService } from './parts.service';
import { CreatePartsRequestDto } from './dto/create-parts-request.dto';
import { ReservePartsDto } from './dto/reserve-parts.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

// ---------------------------------------------------------------------------
// Parts Requests Controller
// ---------------------------------------------------------------------------

@ApiTags('Parts Requests')
@Controller('parts-requests')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class PartsRequestsController {
  constructor(private partsService: PartsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({ summary: 'Create a parts request for a service order' })
  async create(
    @Body() dto: CreatePartsRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.partsService.createRequest(dto, user.sub);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({ summary: 'Get a parts request by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.partsService.findRequestById(id);
  }

  @Get('by-order/:serviceOrderId')
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({ summary: 'List parts requests for a service order' })
  async findByServiceOrder(
    @Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string,
  ) {
    return this.partsService.findByServiceOrder(serviceOrderId);
  }

  @Post(':id/reserve')
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({ summary: 'Reserve parts against a parts request' })
  async reserve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReservePartsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.partsService.reserveParts(id, dto, user.sub);
  }
}

// ---------------------------------------------------------------------------
// Inventory Transfers Controller
// ---------------------------------------------------------------------------

@ApiTags('Inventory Transfers')
@Controller('inventory-transfers')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class InventoryTransfersController {
  constructor(private partsService: PartsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({ summary: 'Create an inventory transfer request' })
  async create(
    @Body() dto: CreateTransferDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.partsService.createTransfer(dto, user.sub);
  }

  @Post(':id/receive')
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({ summary: 'Mark an inventory transfer as received' })
  async receive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.partsService.receiveTransfer(id, user.sub);
  }
}

// ---------------------------------------------------------------------------
// Parts Dashboard Controller
// ---------------------------------------------------------------------------

@ApiTags('Parts Dashboard')
@Controller('parts')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class PartsDashboardController {
  constructor(private partsService: PartsService) {}

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  @ApiOperation({
    summary: 'Parts readiness dashboard — upcoming jobs needing parts',
  })
  @ApiQuery({
    name: 'siteId',
    required: true,
    type: String,
    description: 'Site UUID to filter dashboard',
  })
  async dashboard(@Query('siteId', ParseUUIDPipe) siteId: string) {
    return this.partsService.getPartsReadinessDashboard(siteId);
  }
}
