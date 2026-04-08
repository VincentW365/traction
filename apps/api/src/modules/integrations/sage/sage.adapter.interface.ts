export interface SageAdapter {
  pushLaborLines(
    serviceOrderId: string,
    lines: Array<{ description: string; hours: number; rate: number }>,
  ): Promise<{ sageRef: string } | { manualBridge: true; instructions: string }>;
}
