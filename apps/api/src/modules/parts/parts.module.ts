import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import {
  PartsRequestsController,
  InventoryTransfersController,
  PartsDashboardController,
} from './parts.controller';
import { PartsService } from './parts.service';

@Module({
  imports: [SchedulingModule],
  controllers: [
    PartsRequestsController,
    InventoryTransfersController,
    PartsDashboardController,
  ],
  providers: [PartsService],
  exports: [PartsService],
})
export class PartsModule {}
