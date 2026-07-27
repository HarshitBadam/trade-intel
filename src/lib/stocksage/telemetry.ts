type StockSageEvent = {
  event: string;
  route?: string;
  reasonCode?: string;
  durationMs?: number;
  guardMs?: number;
  retrievalMs?: number;
  synthesisMs?: number;
  providerCount?: number;
  sourceCount?: number;
};

export function logStockSage(event: StockSageEvent): void {
  console.info(`[stocksage] ${JSON.stringify(event)}`);
}
