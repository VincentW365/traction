import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { ClassificationController } from './classification.controller';
import { ClassificationService } from './classification.service';

@Module({
  controllers: [VehiclesController, ClassificationController],
  providers: [VehiclesService, ClassificationService],
  exports: [VehiclesService, ClassificationService],
})
export class VehiclesModule {}
