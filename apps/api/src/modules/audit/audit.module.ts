import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { StatusHistoryService } from './status-history.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, StatusHistoryService],
  exports: [AuditService, StatusHistoryService],
})
export class AuditModule {}
