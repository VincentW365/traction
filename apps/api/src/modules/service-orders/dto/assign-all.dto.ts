import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

/** CR-2026-068 — assign one technician to all of a visit's approved orders. */
export class AssignAllDto {
  @ApiProperty({ description: 'Technician to assign to every approved order on the visit' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;

  /** CR-2026-100 — assign despite an existing open workload (advisor/manager judgement; audited). */
  @ApiPropertyOptional({ description: 'Proceed although the technician already has open work (audited)' })
  @IsOptional()
  @IsBoolean()
  acknowledgeWorkload?: boolean;
}
