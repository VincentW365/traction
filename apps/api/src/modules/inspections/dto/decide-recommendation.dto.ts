import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** CR-2026-034 (C-3) — customer decision on a recommendation (PENDING is not a valid input). */
export class DecideRecommendationDto {
  @ApiProperty({ enum: ['APPROVED', 'DECLINED', 'DEFERRED'] })
  @IsIn(['APPROVED', 'DECLINED', 'DEFERRED'])
  decision!: 'APPROVED' | 'DECLINED' | 'DEFERRED';
}
