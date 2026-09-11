import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AppointmentServiceItemDto {
  @ApiProperty({ description: 'Service type code (e.g., OIL_CHANGE)' })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;

  @ApiPropertyOptional({ description: 'Quantity (defaults to 1)', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @ApiPropertyOptional({ description: 'Notes for this service request' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateAppointmentDto {
  @ApiProperty({ description: 'Site ID where the appointment is booked' })
  @IsUUID()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ description: 'Customer ID' })
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty({ description: 'Vehicle ID' })
  @IsUUID()
  @IsNotEmpty()
  vehicleId!: string;

  @ApiProperty({
    description: 'Scheduled start time (ISO 8601 datetime string)',
    example: '2026-04-15T09:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  scheduledStartAt!: string;

  @ApiProperty({
    description: 'Service types to include in the appointment',
    type: [AppointmentServiceItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppointmentServiceItemDto)
  serviceTypes!: AppointmentServiceItemDto[];

  @ApiPropertyOptional({ description: 'General appointment notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'CR-2026-105c — set true to book past workshop capacity after the 409 CAPACITY_FULL warning (audited).',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeCapacity?: boolean;
}
