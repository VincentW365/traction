import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CustomerSearchDto {
  @ApiProperty({
    description: 'Search query — matches phone, name, or customer number',
    minLength: 2,
  })
  @IsString()
  @MinLength(2)
  q!: string;
}
