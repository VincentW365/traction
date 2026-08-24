import { Module } from '@nestjs/common';
import { ResourcesService } from './resources.service';
import { ResourceAdminService } from './resource-admin.service';
import { ResourcesController } from './resources.controller';

@Module({
  controllers: [ResourcesController],
  providers: [ResourcesService, ResourceAdminService],
  exports: [ResourcesService, ResourceAdminService],
})
export class ResourcesModule {}
