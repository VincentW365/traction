import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WalkInsController } from './walk-ins.controller';
import { WalkInsService } from './walk-ins.service';

// CR-2026-105b — SchedulingModule so a walk-in is ranked the moment it is registered (QUE-002).
@Module({
  imports: [SchedulingModule],
  controllers: [WalkInsController],
  providers: [WalkInsService],
  exports: [WalkInsService],
})
export class WalkInsModule {}
