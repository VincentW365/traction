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
import { PERMISSIONS } from '../../common/constants/permissions';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerSearchDto } from './dto/customer-search.dto';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_SEARCH)
  @ApiOperation({ summary: 'Search customers by phone, name, or customer number' })
  @ApiOkResponse({ description: 'List of matching customers (max 20)' })
  async search(@Query() dto: CustomerSearchDto) {
    return this.customersService.search(dto.q, dto.includeHistorical === 'true');
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
  @ApiOperation({ summary: 'Get a customer by ID with their vehicles' })
  @ApiOkResponse({ description: 'Customer with vehicles' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.findById(id);
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
