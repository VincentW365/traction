import { Module } from '@nestjs/common';
import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';
import { SearchService } from './search.service';
import { VisitNotesController } from './visit-notes.controller';
import { VisitNotesService } from './visit-notes.service';
import { ReconciliationController } from '../data-import/reconciliation.controller';
import { ReconciliationService } from '../data-import/reconciliation.service';

/**
 * CR-2026-097 — Visit Record aggregate + global search.
 * CR-2026-099 — also hosts the historical-visit reconciliation workstream
 * (data-import has no module of its own; visits is the natural home since the
 * unit of review IS the visit).
 * CR-2026-101 — typed operational visit notes (concern/advisor/manager/
 * technician/safety/data-report) with the advisor attention queue.
 */
@Module({
  controllers: [VisitsController, VisitNotesController, ReconciliationController],
  providers: [VisitsService, SearchService, VisitNotesService, ReconciliationService],
  exports: [VisitsService],
})
export class VisitsModule {}
