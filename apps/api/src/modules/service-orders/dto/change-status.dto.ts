import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ChangeStatusDto {
  @ApiProperty({
    description: 'Target status (ServiceOrderStatus value)',
    example: 'IN_PROGRESS',
  })
  @IsString()
  @IsNotEmpty()
  toStatus!: string;

  @ApiPropertyOptional({ description: 'Reason code for the transition' })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ description: 'Free-text notes explaining the transition' })
  @IsOptional()
  @IsString()
  notes?: string;
}
