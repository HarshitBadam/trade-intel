import "server-only";

import { createProvenance } from "./provenance";
import type {
  SecFilingMetadata,
  SecSubmission,
  SecTickerRecord,
} from "./sec-edgar-types";
import {
  SEC_ARCHIVES_URL,
  SEC_SUBMISSIONS_URL,
} from "./sec-edgar-urls";

export function asSecRecord(
  value: unknown
): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function asSecArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeSecDate(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : undefined;
}

export function assertOptionalSecDate(
  value: string | undefined,
  name: string
): void {
  if (value && !normalizeSecDate(value)) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
}

export function normalizeCik(value: string | number): string {
  const digits = String(value).replace(/\D/g, "");
  if (!digits || digits.length > 10) {
    throw new Error("CIK must contain 1 to 10 digits");
  }
  return digits.padStart(10, "0");
}

function stringAt(
  source: Record<string, unknown>,
  key: string,
  index: number
): string {
  const value = asSecArray(source[key])[index];
  return typeof value === "string" ? value : "";
}

function numberAt(
  source: Record<string, unknown>,
  key: string,
  index: number
): number | undefined {
  const value = asSecArray(source[key])[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanAt(
  source: Record<string, unknown>,
  key: string,
  index: number
): boolean | undefined {
  const value = asSecArray(source[key])[index];
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

export function normalizeSecFilingRows(
  raw: unknown,
  cik: string,
  fetchedAt: Date
): SecFilingMetadata[] {
  const source = asSecRecord(raw);
  if (!source) return [];
  const accessions = asSecArray(source.accessionNumber);
  const rows: SecFilingMetadata[] = [];

  for (let index = 0; index < accessions.length; index += 1) {
    const accessionNumber = stringAt(source, "accessionNumber", index);
    const form = stringAt(source, "form", index);
    const filedAt = normalizeSecDate(stringAt(source, "filingDate", index));
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
        normalizeSecDate(stringAt(source, "reportDate", index)) || undefined,
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
  const root = asSecRecord(payload);
  if (!root) return [];
  const rows = Object.values(root).flatMap((value): SecTickerRecord[] => {
    const item = asSecRecord(value);
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

export function normalizeSecSubmission(
  payload: unknown,
  fetchedAt: Date = new Date()
): SecSubmission {
  const root = asSecRecord(payload);
  if (!root) throw new Error("SEC submission payload must be an object");
  const cik = normalizeCik(
    typeof root.cik === "string" || typeof root.cik === "number" ? root.cik : ""
  );
  const filings = asSecRecord(root.filings);
  const historicalFiles = asSecArray(filings?.files)
    .flatMap((value): string[] => {
      const item = asSecRecord(value);
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
    tickers: asSecArray(root.tickers)
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toUpperCase()),
    exchanges: asSecArray(root.exchanges).filter(
      (value): value is string => typeof value === "string"
    ),
    ein: typeof root.ein === "string" ? root.ein : undefined,
    stateOfIncorporation:
      typeof root.stateOfIncorporation === "string"
        ? root.stateOfIncorporation
        : undefined,
    fiscalYearEnd:
      typeof root.fiscalYearEnd === "string" ? root.fiscalYearEnd : undefined,
    filings: normalizeSecFilingRows(filings?.recent, cik, fetchedAt),
    historicalFiles,
    provenance: createProvenance({
      provider: "sec_edgar",
      fetchedAt,
      sourceUrl,
    }),
  };
}
