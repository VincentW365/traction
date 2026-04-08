import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AppointmentServiceItemDto } from './create-appointment.dto';

export class UpdateAppointmentDto {
  @ApiPropertyOptional({
    description: 'New scheduled start time (ISO 8601 datetime string)',
    example: '2026-04-15T10:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  scheduledStartAt?: string;

  @ApiPropertyOptional({ description: 'Updated appointment notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Replacement service types list (replaces existing appointment services)',
    type: [AppointmentServiceItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppointmentServiceItemDto)
  serviceTypes?: AppointmentServiceItemDto[];
}
