import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

@Module({
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
