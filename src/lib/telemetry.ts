export type StockSageEvent = {
  event: string;
  route?: string;
  reasonCode?: string;
  durationMs?: number;
  guardMs?: number;
  providerCalls?: Record<string, number>;
  yields?: Record<string, number>;
  detail?: string;
};

const quiet = process.env.STOCKSAGE_TELEMETRY === "quiet";

export function logStockSage(event: StockSageEvent): void {
  if (!quiet) console.info(`[stocksage] ${JSON.stringify(event)}`);
}
