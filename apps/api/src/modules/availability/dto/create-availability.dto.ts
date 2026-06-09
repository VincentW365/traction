import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

const VALID_STATUSES = ['AVAILABLE', 'ON_BREAK', 'OFF_FLOOR', 'ABSENT'];

export class CreateAvailabilityDto {
  @ApiProperty({ description: 'Technician ID' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;

  @ApiProperty({ description: 'Date (YYYY-MM-DD)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD format' })
  date!: string;

  @ApiProperty({ description: 'Shift start time (HH:mm)', default: '08:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'shiftStart must be HH:mm format' })
  shiftStart!: string;

  @ApiProperty({ description: 'Shift end time (HH:mm)', default: '17:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'shiftEnd must be HH:mm format' })
  shiftEnd!: string;

  @ApiPropertyOptional({ description: 'Status', enum: VALID_STATUSES, default: 'AVAILABLE' })
  @IsOptional()
  @IsString()
  @IsIn(VALID_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
