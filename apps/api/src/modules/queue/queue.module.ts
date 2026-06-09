import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { QueueService } from './queue.service';
import { QueueBoardController, QueueTicketsController } from './queue.controller';
import { DisplayController } from './display.controller';
import { QueueGateway } from './queue.gateway';

@Module({
  imports: [SchedulingModule],
  controllers: [QueueBoardController, QueueTicketsController, DisplayController],
  providers: [QueueService, QueueGateway],
  exports: [QueueService],
})
export class QueueModule {}
