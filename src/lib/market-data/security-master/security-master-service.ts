import "server-only";

import { hasPolygon } from "@/lib/config";
import { normalizeCorporateActions } from "./corporate-action-normalization";
import { polygonFetch } from "../providers/polygon";
import { normalizeTicker } from "./security-master-normalization";
import { createPolygonSecurityMasterAdapter } from "./security-master-polygon";
import { createSecSecurityMasterAdapter } from "./security-master-sec";
import type {
  CorporateAction,
  CorporateActionRange,
  CorporateActionRetrievalResult,
  ResolveSecurityQuery,
  SecurityMasterOptions,
  SecurityMasterProviderAdapter,
  SecurityMasterRecord,
  SecurityMasterSnapshot,
} from "./security-master-types";
import { createYahooSecurityMasterAdapter } from "./security-master-yahoo";

function defaultAdapters(
  options: SecurityMasterOptions
): SecurityMasterProviderAdapter[] {
  const now = options.now ?? (() => new Date());
  if (options.venue === "ASX") {
    return [createYahooSecurityMasterAdapter(options.yahooFetch ?? fetch, now)];
  }
  const adapters: SecurityMasterProviderAdapter[] = [];
  if (
    options.polygonAvailable ??
    (Boolean(options.polygonFetch) || hasPolygon)
  ) {
    adapters.push(
      createPolygonSecurityMasterAdapter(options.polygonFetch ?? polygonFetch, now)
    );
  }
  if (options.venue !== "INDEX") {
    adapters.push(createSecSecurityMasterAdapter(options.sec));
  }
  if (options.venue === "INDEX") {
    adapters.push(createYahooSecurityMasterAdapter(options.yahooFetch ?? fetch, now));
  }
  return adapters;
}

export async function resolveSecurity(
  input: ResolveSecurityQuery,
  options: SecurityMasterOptions = {}
): Promise<SecurityMasterRecord | null> {
  const query: ResolveSecurityQuery = {
    ...input,
    ticker: normalizeTicker(input.ticker),
    cik: input.cik?.replace(/\D/g, "").padStart(10, "0"),
    name: input.name?.trim() || undefined,
  };
  if (!query.ticker && !query.cik && !query.name) {
    throw new Error("ticker, cik, or name is required");
  }
  for (const adapter of options.adapters ?? defaultAdapters(options)) {
    try {
      const result = await adapter.resolve(query, options.venue);
      if (result) return result;
    } catch {
      continue;
    }
  }
  return null;
}

export async function getCorporateActions(
  ticker: string,
  range: CorporateActionRange,
  options: SecurityMasterOptions = {}
): Promise<CorporateAction[]> {
  return (await getCorporateActionsResult(ticker, range, options)).actions;
}

export async function getCorporateActionsResult(
  ticker: string,
  range: CorporateActionRange,
  options: SecurityMasterOptions = {}
): Promise<CorporateActionRetrievalResult> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) throw new Error("ticker is required");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(range.startSession) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(range.endSession) ||
    range.startSession > range.endSession
  ) {
    throw new Error("corporate-action range must be ordered YYYY-MM-DD dates");
  }
  const adapters = options.adapters ?? defaultAdapters(options);
  const outcomes = await Promise.all(
    adapters.map(async (adapter) => {
      if (!adapter.corporateActions) {
        return {
          actions: [] as CorporateAction[],
          diagnostic: {
            provider: adapter.provider,
            status: "unsupported" as const,
            actionCount: 0,
          },
        };
      }
      try {
        const actions = await adapter.corporateActions(
          symbol,
          range,
          options.venue
        );
        return {
          actions,
          diagnostic: {
            provider: adapter.provider,
            status: "succeeded" as const,
            actionCount: actions.length,
          },
        };
      } catch (error) {
        return {
          actions: [] as CorporateAction[],
          diagnostic: {
            provider: adapter.provider,
            status: "failed" as const,
            actionCount: 0,
            error:
              error instanceof Error
                ? error.message.slice(0, 200)
                : "unknown provider error",
          },
        };
      }
    })
  );
  const actions = normalizeCorporateActions(
    outcomes.flatMap((outcome) => outcome.actions)
  ).filter(
    (action) =>
      action.exDate >= range.startSession && action.exDate <= range.endSession
  );
  const diagnostics = outcomes.map((outcome) => outcome.diagnostic);
  const capable = diagnostics.filter(
    (diagnostic) => diagnostic.status !== "unsupported"
  );
  const succeeded = capable.filter(
    (diagnostic) => diagnostic.status === "succeeded"
  ).length;
  const failed = capable.filter(
    (diagnostic) => diagnostic.status === "failed"
  ).length;
  return {
    actions,
    range: { ...range },
    status:
      capable.length === 0 || succeeded === 0
        ? "unavailable"
        : failed > 0
          ? "partial"
          : "complete",
    diagnostics,
  };
}

export async function getSecurityMasterSnapshot(
  ticker: string,
  range?: CorporateActionRange,
  options: SecurityMasterOptions = {}
): Promise<SecurityMasterSnapshot> {
  const now = options.now ?? (() => new Date());
  const security = await resolveSecurity({ ticker }, options);
  if (!security) {
    return {
      security: null,
      corporateActions: [],
      asOf: now().toISOString(),
      status: "unavailable",
    };
  }
  const actionRetrieval = range
    ? await getCorporateActionsResult(ticker, range, options)
    : undefined;
  return {
    security,
    corporateActions: actionRetrieval?.actions ?? [],
    corporateActionRetrieval: actionRetrieval,
    asOf: now().toISOString(),
    status:
      !actionRetrieval || actionRetrieval.status === "complete"
        ? "complete"
        : "partial",
  };
}
