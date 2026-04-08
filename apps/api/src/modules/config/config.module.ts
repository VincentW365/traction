import { Module } from '@nestjs/common';
import { ServiceTypesController } from './service-types.controller';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';

@Module({
  controllers: [ServiceTypesController, ConfigController],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigManagementModule {}
