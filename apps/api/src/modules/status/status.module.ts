import { Module } from '@nestjs/common';
import { StatusController, ServiceVisitCompletionController } from './status.controller';

@Module({
  controllers: [StatusController, ServiceVisitCompletionController],
})
export class StatusModule {}
