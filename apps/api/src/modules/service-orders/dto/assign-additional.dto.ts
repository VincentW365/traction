import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class AssignAdditionalDto {
  @ApiProperty({ description: 'Technician ID (helper)' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;

  @ApiPropertyOptional({ description: 'Bay ID (optional)' })
  @IsOptional()
  @IsUUID()
  bayId?: string;

  @ApiPropertyOptional({ description: 'Resource ID (optional, v4.1)' })
  @IsOptional()
  @IsUUID()
  resourceId?: string;
}
