import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class AssignTechnicianDto {
  @ApiProperty({ description: 'Technician ID to assign' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;

  // CR-2026-062 — optional: when omitted the service auto-assigns the first
  // compatible + free bay for the order. Provide one to pick a specific bay.
  @ApiPropertyOptional({ description: 'Work bay ID; omit to auto-assign a compatible free bay' })
  @IsOptional()
  @IsUUID()
  bayId?: string;

  /** CR-2026-100 — assign despite an existing open workload (advisor/manager judgement; audited). */
  @ApiPropertyOptional({ description: 'Proceed although the technician already has open work (audited)' })
  @IsOptional()
  @IsBoolean()
  acknowledgeWorkload?: boolean;
}
