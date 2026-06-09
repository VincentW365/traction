import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class ListRemindersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ enum: ['SCHEDULED', 'SENT', 'ACKNOWLEDGED', 'CANCELLED', 'SUPERSEDED'] })
  @IsOptional()
  @IsString()
  @IsIn(['SCHEDULED', 'SENT', 'ACKNOWLEDGED', 'CANCELLED', 'SUPERSEDED'])
  status?: string;
}
