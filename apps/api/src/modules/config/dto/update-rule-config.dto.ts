import { IsOptional, IsString, IsDateString, Allow } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRuleConfigDto {
  @ApiProperty({ description: 'New rule value (any JSON-compatible value)' })
  @Allow()
  value!: unknown;

  @ApiProperty({ description: 'When this value takes effect (ISO datetime)', required: false })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiProperty({ description: 'Notes about the change', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
