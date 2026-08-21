import { Module } from '@nestjs/common';
import { KpiModule } from '../kpi/kpi.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ServiceOrdersController } from './service-orders.controller';
import { ServiceOrdersService } from './service-orders.service';

@Module({
  imports: [SchedulingModule, KpiModule],
  controllers: [ServiceOrdersController],
  providers: [ServiceOrdersService],
  exports: [ServiceOrdersService],
})
export class ServiceOrdersModule {}
