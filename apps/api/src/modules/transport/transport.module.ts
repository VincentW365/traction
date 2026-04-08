import { Module } from '@nestjs/common';
import { TransportService } from './transport.service';
import {
  TransportRequestsController,
  TransportDispatchController,
} from './transport.controller';

@Module({
  controllers: [TransportRequestsController, TransportDispatchController],
  providers: [TransportService],
  exports: [TransportService],
})
export class TransportModule {}
