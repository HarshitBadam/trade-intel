type TelemetryValue = string | number | boolean | null | undefined;

export function recordMarketIntelligenceEvent(
  event: string,
  fields: Record<string, TelemetryValue> = {}
): void {
  console.info(
    `[market-intelligence] ${JSON.stringify({
      event,
      ...fields,
    })}`
  );
}
