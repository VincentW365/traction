import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

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

  /** CR-2026-100 — assign despite an existing open workload (advisor/manager judgement; audited). */
  @ApiPropertyOptional({ description: 'Proceed although the technician already has open work (audited)' })
  @IsOptional()
  @IsBoolean()
  acknowledgeWorkload?: boolean;
}
