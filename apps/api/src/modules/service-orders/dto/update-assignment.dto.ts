import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ description: 'Swap to a different technician' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiPropertyOptional({ description: 'Change primary status' })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ description: 'Change bay' })
  @IsOptional()
  @IsUUID()
  bayId?: string;
}
