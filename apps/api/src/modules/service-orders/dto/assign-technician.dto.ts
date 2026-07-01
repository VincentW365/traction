import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsOptional } from 'class-validator';

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
}
