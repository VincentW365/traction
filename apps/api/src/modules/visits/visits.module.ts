import { Module } from '@nestjs/common';
import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';
import { SearchService } from './search.service';

/** CR-2026-097 — Visit Record aggregate + global search. */
@Module({
  controllers: [VisitsController],
  providers: [VisitsService, SearchService],
  exports: [VisitsService],
})
export class VisitsModule {}
