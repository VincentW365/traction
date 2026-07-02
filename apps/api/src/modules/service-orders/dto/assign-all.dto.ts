import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty } from 'class-validator';

/** CR-2026-068 — assign one technician to all of a visit's approved orders. */
export class AssignAllDto {
  @ApiProperty({ description: 'Technician to assign to every approved order on the visit' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;
}
