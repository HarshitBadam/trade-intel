import type { MarketCalendar } from "./temporal";
import type { FinanceEntity } from "./types";

function usesAustralianCalendar(entity: FinanceEntity): boolean {
  return (
    entity.market === "au" ||
    entity.jurisdiction === "Australia" ||
    (entity.market === "index" && entity.ticker === "AXJO")
  );
}

export function primaryCalendar(entities: FinanceEntity[]): MarketCalendar {
  return entities.some(usesAustralianCalendar) ? "AU" : "US";
}
