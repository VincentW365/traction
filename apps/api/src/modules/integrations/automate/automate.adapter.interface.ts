export interface PartLookupResult {
  parts: Array<{ sku: string; name: string; price?: number }>;
}

export interface ManualBridgePrompt {
  manualBridge: true;
  instructions: string;
}

export interface AutomateAdapter {
  lookupPartsByVin(vin: string): Promise<PartLookupResult | ManualBridgePrompt>;
  createPartsOrder(request: {
    partsRequestId: string;
    items: Array<{ sku: string; qty: number }>;
  }): Promise<{ orderId: string } | ManualBridgePrompt>;
  getOrderStatus(externalId: string): Promise<{ status: string; updatedAt: string } | ManualBridgePrompt>;
}
