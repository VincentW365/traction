import { Injectable } from '@nestjs/common';
import { SageAdapter } from './sage.adapter.interface';

@Injectable()
export class SageManualAdapter implements SageAdapter {
  async pushLaborLines(
    serviceOrderId: string,
    lines: Array<{ description: string; hours: number; rate: number }>,
  ): Promise<{ manualBridge: true; instructions: string }> {
    const linesSummary = lines.map((l) => `${l.description}: ${l.hours}h @ $${l.rate}`).join('; ');
    return {
      manualBridge: true,
      instructions: `Enter the following labor lines into Sage for Service Order ${serviceOrderId}: ${linesSummary}. Record the Sage reference number back in BSOP.`,
    };
  }
}
