import { Module } from '@nestjs/common';
import { ScheduleHoldsController } from './schedule-holds.controller';
import { ScheduleHoldsService } from './schedule-holds.service';

/** CR-2026-026 — Schedule Quick-Book Holds (advisory; isolated from scheduling). */
@Module({
  controllers: [ScheduleHoldsController],
  providers: [ScheduleHoldsService],
  exports: [ScheduleHoldsService],
})
export class ScheduleHoldsModule {}
