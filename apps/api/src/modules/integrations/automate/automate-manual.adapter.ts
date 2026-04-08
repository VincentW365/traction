import { Injectable } from '@nestjs/common';
import { AutomateAdapter, ManualBridgePrompt } from './automate.adapter.interface';

@Injectable()
export class AutomateManualAdapter implements AutomateAdapter {
  async lookupPartsByVin(vin: string): Promise<ManualBridgePrompt> {
    return {
      manualBridge: true,
      instructions: `Look up parts for VIN ${vin} in Automate. Copy the matching parts list back into BSOP.`,
    };
  }

  async createPartsOrder(request: {
    partsRequestId: string;
    items: Array<{ sku: string; qty: number }>;
  }): Promise<ManualBridgePrompt> {
    const itemList = request.items.map((i) => `${i.sku} x${i.qty}`).join(', ');
    return {
      manualBridge: true,
      instructions: `Create an order in Automate for: ${itemList}. Enter the Automate order number back into BSOP under Parts Request ${request.partsRequestId}.`,
    };
  }

  async getOrderStatus(externalId: string): Promise<ManualBridgePrompt> {
    return {
      manualBridge: true,
      instructions: `Check the status of Automate order ${externalId} and update the parts request status in BSOP accordingly.`,
    };
  }
}
