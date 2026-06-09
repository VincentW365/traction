import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignResourceDto {
  @ApiProperty({ description: 'Queue ticket ID to assign to this resource' })
  @IsUUID()
  @IsNotEmpty()
  queueTicketId!: string;

  @ApiPropertyOptional({ description: 'Technician ID to assign (optional)' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiPropertyOptional({
    description:
      'Manager override for the DMAIC Rule 3 mobile-jack gate. Allows assigning a mobile jack to a non-sedan (or unknown-class) vehicle. Audited.',
  })
  @IsOptional()
  @IsBoolean()
  mobileJackOverride?: boolean;

  @ApiPropertyOptional({ description: 'Reason for the mobile-jack manager override (recorded in audit)' })
  @IsOptional()
  @IsString()
  overrideReason?: string;
}
