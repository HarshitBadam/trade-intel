import type { DataProvenance } from "../provenance";

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
