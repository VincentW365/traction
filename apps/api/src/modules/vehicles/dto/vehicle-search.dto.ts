import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class VehicleSearchDto {
  @ApiProperty({
    description: 'Search query — matches plate number, VIN, or customer name',
    minLength: 2,
    example: 'ABC',
  })
  @IsString()
  @MinLength(2)
  q!: string;
}
