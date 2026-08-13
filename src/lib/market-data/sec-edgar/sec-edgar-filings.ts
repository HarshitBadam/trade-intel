import "server-only";

import { getSecSubmissions, resolveCik } from "./sec-edgar-client";
import { fetchSecJson } from "./sec-edgar-http";
import {
  assertOptionalSecDate,
  asSecRecord,
  normalizeCik,
  normalizeSecFilingRows,
} from "./sec-edgar-normalization";
import type {
  SecEdgarDependencies,
  SecFilingMetadata,
  SecFilingQuery,
} from "./sec-edgar-types";
import { SEC_SUBMISSIONS_URL } from "./sec-edgar-urls";

function formMatches(form: string, forms: readonly string[] | undefined): boolean {
  if (!forms?.length) return true;
  const wanted = new Set(forms.map((value) => value.trim().toUpperCase()));
  return wanted.has(form.toUpperCase());
}

function filingMatches(
  filing: SecFilingMetadata,
  query: SecFilingQuery
): boolean {
  return (
    formMatches(filing.form, query.forms) &&
    (!query.filedFrom || filing.filedAt >= query.filedFrom) &&
    (!query.filedTo || filing.filedAt <= query.filedTo)
  );
}

export async function listSecFilings(
  query: SecFilingQuery,
  dependencies: SecEdgarDependencies = {}
): Promise<SecFilingMetadata[]> {
  if (!query.cik && !query.ticker) throw new Error("ticker or cik is required");
  assertOptionalSecDate(query.filedFrom, "filedFrom");
  assertOptionalSecDate(query.filedTo, "filedTo");

  const tickerCik = query.ticker
    ? await resolveCik(query.ticker, dependencies)
    : null;
  if (query.ticker && !tickerCik) return [];
  const cik = query.cik ? normalizeCik(query.cik) : tickerCik!;
  if (tickerCik && tickerCik !== cik) {
    throw new Error("ticker and CIK resolve to different issuers");
  }

  const submission = await getSecSubmissions(cik, dependencies);
  const fetchedAt = (dependencies.now ?? (() => new Date()))();
  const historical = await Promise.all(
    submission.historicalFiles.map(async (file) => {
      const payload = await fetchSecJson(
        `${SEC_SUBMISSIONS_URL}${file}`,
        dependencies
      );
      const root = asSecRecord(payload);
      const filings = asSecRecord(root?.filings);
      return normalizeSecFilingRows(
        filings?.recent ?? root?.recent ?? payload,
        cik,
        fetchedAt
      );
    })
  );

  const deduped = new Map<string, SecFilingMetadata>();
  for (const filing of [...submission.filings, ...historical.flat()]) {
    if (filingMatches(filing, query)) {
      deduped.set(filing.accessionNumber, filing);
    }
  }
  const rows = [...deduped.values()].sort(
    (left, right) =>
      right.filedAt.localeCompare(left.filedAt) ||
      right.accessionNumber.localeCompare(left.accessionNumber)
  );
  const limit =
    query.limit === undefined
      ? 10
      : Math.max(0, Math.min(100, Math.floor(query.limit)));
  return rows.slice(0, limit);
}

export async function getSecFilingsForTicker(
  ticker: string,
  options: Omit<SecFilingQuery, "ticker" | "cik"> = {},
  dependencies: SecEdgarDependencies = {}
): Promise<SecFilingMetadata[]> {
  return listSecFilings({ ...options, ticker }, dependencies);
}
