import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateSkillDto {
  @ApiPropertyOptional({ description: 'Proficiency level (1-5)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  proficiencyLevel?: number;

  @ApiPropertyOptional({ description: 'Whether this is a primary skill' })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
