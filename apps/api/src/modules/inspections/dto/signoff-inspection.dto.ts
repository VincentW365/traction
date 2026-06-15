import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** CR-2026-034 (C-3) — senior-tech sign-off = typed/authenticated acknowledgment (identity from JWT). */
export class SignoffInspectionDto {
  @ApiProperty({ description: 'Senior technician typed acknowledgment (their name)' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  typedName!: string;
}
