import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LinkTechnicianDto {
  @ApiProperty({ description: 'Unique employee code (e.g., TECH-006)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  employeeCode!: string;
}
