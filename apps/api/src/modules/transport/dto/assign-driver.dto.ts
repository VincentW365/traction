import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsUUID } from 'class-validator';

export class AssignDriverDto {
  @ApiProperty({ description: 'User ID of the assigned driver' })
  @IsUUID()
  @IsNotEmpty()
  driverUserId!: string;

  @ApiProperty({ description: 'Scheduled pickup time (ISO 8601)' })
  @IsISO8601()
  @IsNotEmpty()
  scheduledPickupAt!: string;
}
