import "server-only";

import { slidingLimiter } from "./limiter";
import { createProvenance, type DataProvenance } from "./provenance";

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/";
const SEC_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/";
const SEC_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/";
const SEC_TIMEOUT_MS = 10_000;
const TICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const SUBMISSION_CACHE_TTL_MS = 60 * 60 * 1_000;

/** SEC asks automated clients to identify an organization and contact. */
export const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ??
  "TradeIntel StockSage research service support@tradeintel.app";

const acquireSecSlot = slidingLimiter(8, 1_000);

export type SecFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type SecFetch = (
  url: string,
  init: RequestInit
) => Promise<SecFetchResponse>;

export type SecEdgarDependencies = {
  fetch?: SecFetch;
  acquire?: () => Promise<void>;
  userAgent?: string;
  now?: () => Date;
};

export type SecTickerRecord = {
  ticker: string;
  cik: string;
  title: string;
};

export type SecFilingMetadata = {
  accessionNumber: string;
  cik: string;
  form: string;
  filedAt: string;
  periodOfReport?: string;
  acceptanceDateTime?: string;
  primaryDocument?: string;
  primaryDocumentDescription?: string;
  fileNumber?: string;
  filmNumber?: string;
  items?: string;
  size?: number;
  isXbrl?: boolean;
  isInlineXbrl?: boolean;
  url: string;
  documentUrl?: string;
  provenance: DataProvenance;
};

export type SecSubmission = {
  cik: string;
  entityType?: string;
  sic?: string;
  sicDescription?: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  ein?: string;
  stateOfIncorporation?: string;
  fiscalYearEnd?: string;
  filings: SecFilingMetadata[];
  historicalFiles: string[];
  provenance: DataProvenance;
};

export type SecFilingQuery = {
  cik?: string;
  ticker?: string;
  forms?: readonly string[];
  filedFrom?: string;
  filedTo?: string;
  limit?: number;
};

export type SecCompanyFact = {
  id: string;
  cik: string;
  entityName: string;
  taxonomy: string;
  concept: string;
  label: string;
  description?: string;
  unit: string;
  value: number | string;
  periodStart?: string;
  periodEnd: string;
  instant: boolean;
  accessionNumber: string;
  form: string;
  filedAt: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
  frame?: string;
  provenance: DataProvenance;
};

export type SecCompanyFactFilters = {
  concepts?: readonly string[];
  taxonomies?: readonly string[];
  units?: readonly string[];
  forms?: readonly string[];
  filedFrom?: string;
  filedTo?: string;
  periodFrom?: string;
  periodTo?: string;
  latestOnly?: boolean;
};

export type SecCompanyFactsQuery = SecCompanyFactFilters & {
  cik?: string;
  ticker?: string;
};

type CacheEntry<T> = { expiresAt: number; value: Promise<T> };
let tickerMapCache: CacheEntry<SecTickerRecord[]> | undefined;
const submissionCache = new Map<string, CacheEntry<SecSubmission>>();

function date(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : undefined;
}

export function normalizeCik(value: string | number): string {
  const digits = String(value).replace(/\D/g, "");
  if (!digits || digits.length > 10) throw new Error("CIK must contain 1 to 10 digits");
  return digits.padStart(10, "0");
}

function shouldUseDefaultCache(dependencies: SecEdgarDependencies): boolean {
  return (
    dependencies.fetch === undefined &&
    dependencies.acquire === undefined &&
    dependencies.userAgent === undefined &&
    dependencies.now === undefined
  );
}

async function secJson(
  url: string,
  dependencies: SecEdgarDependencies
): Promise<unknown> {
  await (dependencies.acquire ?? acquireSecSlot)();
  const response = await (dependencies.fetch ?? fetch)(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": dependencies.userAgent ?? SEC_USER_AGENT,
    },
    signal: AbortSignal.timeout(SEC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SEC EDGAR responded with ${response.status}`);
  return response.json();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringAt(source: Record<string, unknown>, key: string, index: number): string {
  const value = strings(source[key])[index];
  return typeof value === "string" ? value : "";
}

function numberAt(
  source: Record<string, unknown>,
  key: string,
  index: number
): number | undefined {
  const value = strings(source[key])[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanAt(
  source: Record<string, unknown>,
  key: string,
  index: number
): boolean | undefined {
  const value = strings(source[key])[index];
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

function archiveUrls(
  cik: string,
  accessionNumber: string,
  primaryDocument?: string
): { url: string; documentUrl?: string } {
  const cikNumber = String(Number(cik));
  const accessionPath = accessionNumber.replaceAll("-", "");
  const base = `${SEC_ARCHIVES_URL}${cikNumber}/${accessionPath}`;
  return {
    url: `${base}/${accessionNumber}-index.html`,
    documentUrl: primaryDocument
      ? `${base}/${encodeURIComponent(primaryDocument)}`
      : undefined,
  };
}

function normalizeFilingRows(
  raw: unknown,
  cik: string,
  fetchedAt: Date
): SecFilingMetadata[] {
  const source = record(raw);
  if (!source) return [];
  const accessions = strings(source.accessionNumber);
  const rows: SecFilingMetadata[] = [];
  for (let index = 0; index < accessions.length; index += 1) {
    const accessionNumber = stringAt(source, "accessionNumber", index);
    const form = stringAt(source, "form", index);
    const filedAt = date(stringAt(source, "filingDate", index));
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber) || !form || !filedAt) {
      continue;
    }
    const primaryDocument =
      stringAt(source, "primaryDocument", index) || undefined;
    const urls = archiveUrls(cik, accessionNumber, primaryDocument);
    rows.push({
      accessionNumber,
      cik,
      form,
      filedAt,
      periodOfReport:
        date(stringAt(source, "reportDate", index)) || undefined,
      acceptanceDateTime:
        stringAt(source, "acceptanceDateTime", index) || undefined,
      primaryDocument,
      primaryDocumentDescription:
        stringAt(source, "primaryDocDescription", index) || undefined,
      fileNumber: stringAt(source, "fileNumber", index) || undefined,
      filmNumber: stringAt(source, "filmNumber", index) || undefined,
      items: stringAt(source, "items", index) || undefined,
      size: numberAt(source, "size", index),
      isXbrl: booleanAt(source, "isXBRL", index),
      isInlineXbrl: booleanAt(source, "isInlineXBRL", index),
      ...urls,
      provenance: createProvenance({
        provider: "sec_edgar",
        fetchedAt,
        sourceUrl: urls.url,
      }),
    });
  }
  return rows;
}

export function normalizeSecTickerMap(payload: unknown): SecTickerRecord[] {
  const root = record(payload);
  if (!root) return [];
  const rows = Object.values(root).flatMap((value): SecTickerRecord[] => {
    const item = record(value);
    if (!item) return [];
    const ticker =
      typeof item.ticker === "string" ? item.ticker.trim().toUpperCase() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const cikValue =
      typeof item.cik_str === "string" || typeof item.cik_str === "number"
        ? item.cik_str
        : undefined;
    if (!ticker || cikValue === undefined) return [];
    try {
      return [{ ticker, title: title || ticker, cik: normalizeCik(cikValue) }];
    } catch {
      return [];
    }
  });
  return [
    ...new Map(
      rows
        .sort((left, right) => left.ticker.localeCompare(right.ticker))
        .map((item) => [item.ticker, item])
    ).values(),
  ];
}

async function getTickerMap(
  dependencies: SecEdgarDependencies = {}
): Promise<SecTickerRecord[]> {
  if (!shouldUseDefaultCache(dependencies)) {
    return normalizeSecTickerMap(await secJson(SEC_TICKERS_URL, dependencies));
  }
  const now = Date.now();
  if (tickerMapCache && tickerMapCache.expiresAt > now) return tickerMapCache.value;
  const value = secJson(SEC_TICKERS_URL, dependencies).then(normalizeSecTickerMap);
  tickerMapCache = { expiresAt: now + TICKER_CACHE_TTL_MS, value };
  try {
    return await value;
  } catch (error) {
    tickerMapCache = undefined;
    throw error;
  }
}

export async function resolveCik(
  ticker: string,
  dependencies: SecEdgarDependencies = {}
): Promise<string | null> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return null;
  return (await getTickerMap(dependencies)).find((item) => item.ticker === normalized)
    ?.cik ?? null;
}

export function normalizeSecSubmission(
  payload: unknown,
  fetchedAt: Date = new Date()
): SecSubmission {
  const root = record(payload);
  if (!root) throw new Error("SEC submission payload must be an object");
  const cik = normalizeCik(
    typeof root.cik === "string" || typeof root.cik === "number" ? root.cik : ""
  );
  const filings = record(root.filings);
  const recent = filings ? filings.recent : undefined;
  const historicalFiles = strings(filings?.files)
    .flatMap((value): string[] => {
      const item = record(value);
      return typeof item?.name === "string" ? [item.name] : [];
    })
    .sort();
  const sourceUrl = `${SEC_SUBMISSIONS_URL}CIK${cik}.json`;
  return {
    cik,
    entityType:
      typeof root.entityType === "string" ? root.entityType : undefined,
    sic: typeof root.sic === "string" ? root.sic : undefined,
    sicDescription:
      typeof root.sicDescription === "string" ? root.sicDescription : undefined,
    name: typeof root.name === "string" ? root.name : "",
    tickers: strings(root.tickers)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toUpperCase()),
    exchanges: strings(root.exchanges).filter(
      (value): value is string => typeof value === "string"
    ),
    ein: typeof root.ein === "string" ? root.ein : undefined,
    stateOfIncorporation:
      typeof root.stateOfIncorporation === "string"
        ? root.stateOfIncorporation
        : undefined,
    fiscalYearEnd:
      typeof root.fiscalYearEnd === "string" ? root.fiscalYearEnd : undefined,
    filings: normalizeFilingRows(recent, cik, fetchedAt),
    historicalFiles,
    provenance: createProvenance({
      provider: "sec_edgar",
      fetchedAt,
      sourceUrl,
    }),
  };
}

export async function getSecSubmissions(
  cik: string,
  dependencies: SecEdgarDependencies = {}
): Promise<SecSubmission> {
  const normalized = normalizeCik(cik);
  const load = async () =>
    normalizeSecSubmission(
      await secJson(`${SEC_SUBMISSIONS_URL}CIK${normalized}.json`, dependencies),
      (dependencies.now ?? (() => new Date()))()
    );
  if (!shouldUseDefaultCache(dependencies)) return load();
  const cached = submissionCache.get(normalized);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const value = load();
  submissionCache.set(normalized, {
    expiresAt: now + SUBMISSION_CACHE_TTL_MS,
    value,
  });
  try {
    return await value;
  } catch (error) {
    submissionCache.delete(normalized);
    throw error;
  }
}

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

function assertOptionalDate(value: string | undefined, name: string): void {
  if (value && !date(value)) throw new Error(`${name} must be YYYY-MM-DD`);
}

export async function listSecFilings(
  query: SecFilingQuery,
  dependencies: SecEdgarDependencies = {}
): Promise<SecFilingMetadata[]> {
  if (!query.cik && !query.ticker) throw new Error("ticker or cik is required");
  assertOptionalDate(query.filedFrom, "filedFrom");
  assertOptionalDate(query.filedTo, "filedTo");
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
      const payload = await secJson(`${SEC_SUBMISSIONS_URL}${file}`, dependencies);
      const root = record(payload);
      const filings = record(root?.filings);
      return normalizeFilingRows(
        filings?.recent ?? root?.recent ?? payload,
        cik,
        fetchedAt
      );
    })
  );
  const deduped = new Map<string, SecFilingMetadata>();
  for (const filing of [...submission.filings, ...historical.flat()]) {
    if (filingMatches(filing, query)) deduped.set(filing.accessionNumber, filing);
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

function normalizedFilterSet(values: readonly string[] | undefined): Set<string> | null {
  return values?.length
    ? new Set(values.map((value) => value.trim().toUpperCase()))
    : null;
}

function factId(fact: Omit<SecCompanyFact, "id" | "provenance">): string {
  return [
    fact.taxonomy,
    fact.concept,
    fact.unit,
    fact.periodStart ?? "",
    fact.periodEnd,
    fact.accessionNumber,
    fact.form,
    String(fact.value),
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function normalizeSecCompanyFacts(
  payload: unknown,
  filters: SecCompanyFactFilters = {},
  fetchedAt: Date = new Date()
): SecCompanyFact[] {
  const root = record(payload);
  const factsRoot = record(root?.facts);
  if (!root || !factsRoot) return [];
  let cik: string;
  try {
    cik = normalizeCik(
      typeof root.cik === "string" || typeof root.cik === "number" ? root.cik : ""
    );
  } catch {
    return [];
  }
  const entityName =
    typeof root.entityName === "string" ? root.entityName : "";
  const concepts = normalizedFilterSet(filters.concepts);
  const taxonomies = normalizedFilterSet(filters.taxonomies);
  const units = normalizedFilterSet(filters.units);
  const forms = normalizedFilterSet(filters.forms);
  const output = new Map<string, SecCompanyFact>();

  for (const [taxonomy, rawConcepts] of Object.entries(factsRoot)) {
    if (taxonomies && !taxonomies.has(taxonomy.toUpperCase())) continue;
    const conceptRoot = record(rawConcepts);
    if (!conceptRoot) continue;
    for (const [concept, rawFact] of Object.entries(conceptRoot)) {
      if (concepts && !concepts.has(concept.toUpperCase())) continue;
      const fact = record(rawFact);
      const unitsRoot = record(fact?.units);
      if (!fact || !unitsRoot) continue;
      for (const [unit, rawObservations] of Object.entries(unitsRoot)) {
        if (units && !units.has(unit.toUpperCase())) continue;
        if (!Array.isArray(rawObservations)) continue;
        for (const rawObservation of rawObservations) {
          const observation = record(rawObservation);
          if (!observation) continue;
          const periodEnd = date(observation.end);
          const periodStart = date(observation.start);
          const filedAt = date(observation.filed);
          const accessionNumber =
            typeof observation.accn === "string" ? observation.accn : "";
          const form = typeof observation.form === "string" ? observation.form : "";
          const value = observation.val;
          if (
            !periodEnd ||
            !filedAt ||
            !accessionNumber ||
            !form ||
            (typeof value !== "number" && typeof value !== "string") ||
            (typeof value === "number" && !Number.isFinite(value)) ||
            (forms && !forms.has(form.toUpperCase())) ||
            (filters.filedFrom && filedAt < filters.filedFrom) ||
            (filters.filedTo && filedAt > filters.filedTo) ||
            (filters.periodFrom && periodEnd < filters.periodFrom) ||
            (filters.periodTo && periodEnd > filters.periodTo)
          ) {
            continue;
          }
          const normalized = {
            cik,
            entityName,
            taxonomy,
            concept,
            label: typeof fact.label === "string" ? fact.label : concept,
            description:
              typeof fact.description === "string" ? fact.description : undefined,
            unit,
            value,
            periodStart,
            periodEnd,
            instant: !periodStart,
            accessionNumber,
            form,
            filedAt,
            fiscalYear:
              typeof observation.fy === "number" &&
              Number.isInteger(observation.fy)
                ? observation.fy
                : undefined,
            fiscalPeriod:
              typeof observation.fp === "string" ? observation.fp : undefined,
            frame:
              typeof observation.frame === "string" ? observation.frame : undefined,
          };
          const id = factId(normalized);
          output.set(id, {
            id,
            ...normalized,
            provenance: createProvenance({
              provider: "sec_edgar",
              fetchedAt,
              sourceUrl: `${SEC_FACTS_URL}CIK${cik}.json`,
            }),
          });
        }
      }
    }
  }

  let rows = [...output.values()].sort(
    (left, right) =>
      left.taxonomy.localeCompare(right.taxonomy) ||
      left.concept.localeCompare(right.concept) ||
      left.unit.localeCompare(right.unit) ||
      left.periodEnd.localeCompare(right.periodEnd) ||
      left.filedAt.localeCompare(right.filedAt) ||
      left.accessionNumber.localeCompare(right.accessionNumber) ||
      left.id.localeCompare(right.id)
  );
  if (filters.latestOnly) {
    const latest = new Map<string, SecCompanyFact>();
    for (const item of rows) {
      latest.set(`${item.taxonomy}:${item.concept}:${item.unit}`, item);
    }
    rows = [...latest.values()].sort(
      (left, right) =>
        left.taxonomy.localeCompare(right.taxonomy) ||
        left.concept.localeCompare(right.concept) ||
        left.unit.localeCompare(right.unit)
    );
  }
  return rows;
}

/** Alias with the shorter name used by callers that already scope to SEC. */
export const normalizeCompanyFacts = normalizeSecCompanyFacts;

export async function getSecCompanyFacts(
  query: SecCompanyFactsQuery,
  dependencies: SecEdgarDependencies = {}
): Promise<SecCompanyFact[]> {
  if (!query.cik && !query.ticker) throw new Error("ticker or cik is required");
  assertOptionalDate(query.filedFrom, "filedFrom");
  assertOptionalDate(query.filedTo, "filedTo");
  assertOptionalDate(query.periodFrom, "periodFrom");
  assertOptionalDate(query.periodTo, "periodTo");
  const tickerCik = query.ticker
    ? await resolveCik(query.ticker, dependencies)
    : null;
  if (query.ticker && !tickerCik) return [];
  const cik = query.cik ? normalizeCik(query.cik) : tickerCik!;
  if (tickerCik && tickerCik !== cik) {
    throw new Error("ticker and CIK resolve to different issuers");
  }
  const payload = await secJson(`${SEC_FACTS_URL}CIK${cik}.json`, dependencies);
  return normalizeSecCompanyFacts(
    payload,
    query,
    (dependencies.now ?? (() => new Date()))()
  );
}

export const getCompanyFacts = getSecCompanyFacts;

export function resetSecEdgarCache(): void {
  tickerMapCache = undefined;
  submissionCache.clear();
}
