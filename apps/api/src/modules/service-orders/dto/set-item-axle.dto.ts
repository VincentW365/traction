import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { AXLE_POSITIONS } from './create-service-order.dto';

/**
 * CR-2026-090 — record which axle a service line covers.
 *
 * Deliberately not nullable: this endpoint exists to ANSWER the question, and
 * clearing an axle back to unknown would move a job out of its benchmark after the
 * work was done. A line entered against the wrong axle is corrected by setting the
 * right one, which is audited like any other change.
 */
export class SetItemAxleDto {
  @ApiProperty({
    enum: AXLE_POSITIONS,
    description:
      'FRONT, REAR, FRONT_AND_REAR, or NOT_APPLICABLE for a service where the axle is irrelevant.',
  })
  @IsEnum(AXLE_POSITIONS as unknown as object)
  axlePosition!: (typeof AXLE_POSITIONS)[number];
}

/**
 * CR-2026-092 — the structured qualifiers a conditional service needs.
 *
 * Controlled values only. Free text was never an option here: the qualifier decides
 * which benchmark the technician is measured against, and "front pads (I think)" is
 * not something a calculation can act on.
 */
export const BRAKE_WORK_TYPES = [
  'PADS',
  'SHOES',
  'ROTOR_OR_DISC',
  'FLUID_OR_BLEED',
  'INSPECTION_ONLY',
  'OTHER',
] as const;

export const TIRE_OPERATIONS = [
  'PRESSURE_OR_TREAD_CHECK',
  'ROTATION',
  'BALANCE',
  'ALIGNMENT',
  'PUNCTURE_REPAIR',
  'REPLACEMENT',
  'OTHER_PHYSICAL_WORK',
] as const;

export class SetItemQualifiersDto {
  @ApiPropertyOptional({
    enum: AXLE_POSITIONS,
    description:
      'Which axle. FRONT_AND_REAR is a valid booking and resolves into two separate contributions.',
  })
  @IsOptional()
  @IsEnum(AXLE_POSITIONS as unknown as object)
  axlePosition?: (typeof AXLE_POSITIONS)[number];

  @ApiPropertyOptional({
    enum: BRAKE_WORK_TYPES,
    description:
      'What the brake work actually is. Front pads, rear shoes and a fluid bleed are different jobs.',
  })
  @IsOptional()
  @IsEnum(BRAKE_WORK_TYPES as unknown as object)
  brakeWorkType?: (typeof BRAKE_WORK_TYPES)[number];

  @ApiPropertyOptional({
    enum: TIRE_OPERATIONS,
    description:
      'What the tyre work actually is. A pressure check sits inside the General Service allowance; a replacement does not.',
  })
  @IsOptional()
  @IsEnum(TIRE_OPERATIONS as unknown as object)
  tireOperation?: (typeof TIRE_OPERATIONS)[number];

  @ApiPropertyOptional({
    description:
      'Units, honoured only where the service’s allowance basis is PER_UNIT. Never multiplies a per-job allowance.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  unitQuantity?: number;
}
