import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class MaintenanceHistoryQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by service type code',
    example: 'OIL_CHANGE',
  })
  @IsOptional()
  @IsString()
  serviceTypeCode?: string;
}
