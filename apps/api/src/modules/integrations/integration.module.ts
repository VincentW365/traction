import { Module } from '@nestjs/common';
import { ExternalRefService } from './external-ref.service';
import { ExternalRefController } from './external-ref.controller';
import { AutomateManualAdapter } from './automate/automate-manual.adapter';
import { SageManualAdapter } from './sage/sage-manual.adapter';

@Module({
  controllers: [ExternalRefController],
  providers: [
    ExternalRefService,
    { provide: 'AUTOMATE_ADAPTER', useClass: AutomateManualAdapter },
    { provide: 'SAGE_ADAPTER', useClass: SageManualAdapter },
  ],
  exports: [ExternalRefService, 'AUTOMATE_ADAPTER', 'SAGE_ADAPTER'],
})
export class IntegrationModule {}
