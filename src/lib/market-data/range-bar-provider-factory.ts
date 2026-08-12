import { hasAlpaca, hasPolygon } from "@/lib/config";
import { getAlpacaBars } from "./alpaca";
import { polygonFetch } from "./polygon";
import { createAlpacaRangeBarProvider } from "./range-bar-provider-alpaca";
import { createPolygonRangeBarProvider } from "./range-bar-provider-polygon";
import { createStooqRangeBarProvider } from "./range-bar-provider-stooq";
import { createYahooRangeBarProvider } from "./range-bar-provider-yahoo";
import type {
  RangeBarDependencies,
  RangeBarProvider,
  RangeBarProviderName,
} from "./range-bar-types";

export function isRangeBarProviderAvailable(
  provider: RangeBarProviderName,
  dependencies: RangeBarDependencies
): boolean {
  const explicit = dependencies.availability?.[provider];
  if (explicit !== undefined) return explicit;
  if (dependencies.providers?.[provider]) return true;
  if (provider === "alpaca") return Boolean(dependencies.alpaca) || hasAlpaca;
  if (provider === "polygon") {
    return Boolean(dependencies.polygonFetch) || hasPolygon;
  }
  return true;
}

export function createRangeBarProvider(
  provider: RangeBarProviderName,
  dependencies: RangeBarDependencies,
  now: () => Date
): RangeBarProvider {
  const injected = dependencies.providers?.[provider];
  if (injected) return injected;
  if (provider === "alpaca") {
    return createAlpacaRangeBarProvider(
      dependencies.alpaca ?? getAlpacaBars,
      now
    );
  }
  if (provider === "polygon") {
    return createPolygonRangeBarProvider(
      dependencies.polygonFetch ?? polygonFetch,
      now
    );
  }
  if (provider === "yahoo") {
    return createYahooRangeBarProvider(dependencies.yahooFetch ?? fetch, now);
  }
  return createStooqRangeBarProvider(dependencies.stooqFetch ?? fetch, now);
}
