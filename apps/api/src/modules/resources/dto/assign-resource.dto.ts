import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class AssignResourceDto {
  @ApiProperty({ description: 'Queue ticket ID to assign to this resource' })
  @IsUUID()
  @IsNotEmpty()
  queueTicketId!: string;

  @ApiPropertyOptional({ description: 'Technician ID to assign (optional)' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;
}
