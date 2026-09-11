import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { StatusController, ServiceVisitCompletionController } from './status.controller';

// CR-2026-105b — SchedulingModule supplies EtaService (public status estimate) and
// SchedulingService (republish estimates when a visit is closed).
@Module({
  imports: [SchedulingModule],
  controllers: [StatusController, ServiceVisitCompletionController],
})
export class StatusModule {}
