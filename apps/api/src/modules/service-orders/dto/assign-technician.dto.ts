import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty } from 'class-validator';

export class AssignTechnicianDto {
  @ApiProperty({ description: 'Technician ID to assign' })
  @IsUUID()
  @IsNotEmpty()
  technicianId!: string;

  @ApiProperty({ description: 'Work bay ID for the assignment' })
  @IsUUID()
  @IsNotEmpty()
  bayId!: string;
}
