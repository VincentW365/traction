import { Module } from '@nestjs/common';
import { ResourcesModule } from '../resources/resources.module';
import { ServiceTypesController } from './service-types.controller';
import { CatalogueReadinessService } from './catalogue-readiness.service';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';

// CR-2026-108 Stage 5C §14 — ResourcesModule supplies the readiness service that
// guards activation of the resource-aware capacity model.
@Module({
  imports: [ResourcesModule],
  controllers: [ServiceTypesController, ConfigController],
  providers: [ConfigService, CatalogueReadinessService],
  exports: [ConfigService],
})
export class ConfigManagementModule {}
