import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** CR-2026-034 (C-5) — convert an APPROVED recommendation into service work. */
export class ToWorkOrderDto {
  @ApiPropertyOptional({ description: "Service type code (defaults to the recommendation's suggested code)" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  serviceTypeCode?: string;
}
