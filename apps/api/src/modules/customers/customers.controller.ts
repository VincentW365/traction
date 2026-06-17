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
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerSearchDto } from './dto/customer-search.dto';
import { CustomerDirectoryDto } from './dto/customer-directory.dto';
import { ServiceHistoryQueryDto } from './dto/service-history-query.dto';

/** Roles that may browse the full directory + see admin-only Import Metadata. */
const DIRECTORY_ROLES = ['ADMIN'];

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: 'Search customers by phone, name, or customer number (privacy-safe list)' })
  @ApiOkResponse({ description: 'List of matching customers (max 20; no phone in list shape)' })
  async search(@Query() dto: CustomerSearchDto) {
    return this.customersService.search(dto.q, dto.includeHistorical === 'true');
  }

  // Declared BEFORE `:id` so /customers/directory is not captured as an id param.
  @Get('directory')
  @RequirePermission(PERMISSIONS.CUSTOMER_DIRECTORY)
  @ApiOperation({ summary: 'Browse the full customer directory (admin/manager): A–Z, sort, filters, pagination' })
  @ApiOkResponse({ description: 'Paginated directory (no phone in list shape)' })
  async directory(@Query() dto: CustomerDirectoryDto) {
    return this.customersService.directory(dto);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CUSTOMER_CREATE)
  @ApiOperation({ summary: 'Create a new customer' })
  @ApiCreatedResponse({ description: 'Customer created successfully' })
  async create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: 'Get a customer detail (formatted phones, loyalty, visit history, staff notes)' })
  @ApiOkResponse({ description: 'Customer detail; Import Metadata included only for ADMIN/MANAGER' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.findById(id, DIRECTORY_ROLES.includes(user.role));
  }

  @Get(':id/service-history')
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: "Full paginated service history for one customer (incl. historical; excludes test data)" })
  @ApiOkResponse({ description: 'Paginated visits with vehicle, mileage, and services performed' })
  async serviceHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: ServiceHistoryQueryDto,
  ) {
    return this.customersService.getServiceHistory(id, dto.limit, dto.offset);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_UPDATE)
  @ApiOperation({ summary: 'Update a customer' })
  @ApiOkResponse({ description: 'Customer updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(id, dto);
  }
}
