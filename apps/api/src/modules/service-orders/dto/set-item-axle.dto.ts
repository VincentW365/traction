import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
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
