import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class AddSkillDto {
  @ApiProperty({ description: 'Skill code (e.g., GENERAL, LUBE, BRAKE)' })
  @IsString()
  @IsNotEmpty()
  skillCode!: string;

  @ApiPropertyOptional({ description: 'Proficiency level (1-5)', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  proficiencyLevel?: number;

  @ApiPropertyOptional({ description: 'Whether this is a primary skill', default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
