import "server-only";

import { getSecSubmissions, resolveCik } from "../sec-edgar/sec-edgar-client";
import type { SecEdgarDependencies } from "../sec-edgar/sec-edgar-types";
import {
  makeSecurityMasterRecord,
  normalizeTicker,
} from "./security-master-normalization";
import type { SecurityMasterProviderAdapter } from "./security-master-types";

export function createSecSecurityMasterAdapter(
  dependencies: SecEdgarDependencies = {}
): SecurityMasterProviderAdapter {
  return {
    provider: "sec_edgar",
    async resolve(query, requestedVenue) {
      if (requestedVenue && requestedVenue !== "US") return null;
      const ticker = normalizeTicker(query.ticker);
      const cik = query.cik
        ? query.cik.replace(/\D/g, "").padStart(10, "0")
        : ticker
          ? await resolveCik(ticker, dependencies)
          : null;
      if (!cik) return null;
      const submission = await getSecSubmissions(cik, dependencies);
      if (
        ticker &&
        submission.tickers.length > 0 &&
        !submission.tickers.includes(ticker)
      ) {
        return null;
      }
      const symbol = ticker ?? submission.tickers[0];
      if (!symbol) return null;
      const exchange = submission.exchanges[submission.tickers.indexOf(symbol)];
      const fetchedAt = dependencies.now?.() ?? new Date();
      return makeSecurityMasterRecord({
        ticker: symbol,
        name: submission.name || query.name || symbol,
        venue: "US",
        currency: "USD",
        kind: "primary",
        provider: "sec_edgar",
        fetchedAt,
        sourceUrl: submission.provenance.sourceUrl,
        cik,
        exchangeCode: exchange,
        jurisdiction: submission.stateOfIncorporation,
        sicCode: submission.sic,
        sicDescription: submission.sicDescription,
        sector: submission.sicDescription ?? null,
        active: true,
        primaryListing: true,
        proxyFor: query.proxyFor,
      });
    },
  };
}
