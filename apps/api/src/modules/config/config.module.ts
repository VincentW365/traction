import { Module } from '@nestjs/common';
import { ServiceTypesController } from './service-types.controller';
import { CatalogueReadinessService } from './catalogue-readiness.service';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';

@Module({
  controllers: [ServiceTypesController, ConfigController],
  providers: [ConfigService, CatalogueReadinessService],
  exports: [ConfigService],
})
export class ConfigManagementModule {}
