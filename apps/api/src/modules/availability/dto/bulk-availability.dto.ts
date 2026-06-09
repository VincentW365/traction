import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const VALID_STATUSES = ['AVAILABLE', 'ON_BREAK', 'OFF_FLOOR', 'ABSENT'];

export class BulkDayEntry {
  @ApiProperty({ description: 'Date (YYYY-MM-DD)' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @ApiProperty({ description: 'Shift start (HH:mm)' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  shiftStart!: string;

  @ApiProperty({ description: 'Shift end (HH:mm)' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/)
  shiftEnd!: string;

  @ApiPropertyOptional({ enum: VALID_STATUSES, default: 'AVAILABLE' })
  @IsOptional()
  @IsString()
  @IsIn(VALID_STATUSES)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class BulkAvailabilityDto {
  @ApiProperty({ description: 'Technician ID' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;

  @ApiProperty({ type: [BulkDayEntry] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkDayEntry)
  days!: BulkDayEntry[];
}
