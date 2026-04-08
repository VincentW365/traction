import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReservationItemDto {
  @ApiProperty({ description: 'Parts request item ID to reserve against' })
  @IsUUID()
  partsRequestItemId!: string;

  @ApiProperty({ description: 'Quantity to reserve', minimum: 1 })
  @IsInt()
  @Min(1)
  qty!: number;

  @ApiPropertyOptional({
    description: 'Inventory location code where stock is held',
  })
  @IsOptional()
  @IsString()
  inventoryLocationCode?: string;
}

export class ReservePartsDto {
  @ApiProperty({
    description: 'Reservation entries for one or more items',
    type: [ReservationItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationItemDto)
  reservations!: ReservationItemDto[];
}
