import "server-only";

import { createProvenance } from "../provenance";
import { resolveCik } from "./sec-edgar-client";
import { fetchSecJson } from "./sec-edgar-http";
import {
  assertOptionalSecDate,
  asSecRecord,
  normalizeCik,
  normalizeSecDate,
} from "./sec-edgar-normalization";
import type {
  SecCompanyFact,
  SecCompanyFactFilters,
  SecCompanyFactsQuery,
  SecEdgarDependencies,
} from "./sec-edgar-types";
import { SEC_FACTS_URL } from "./sec-edgar-urls";

function normalizedFilterSet(
  values: readonly string[] | undefined
): Set<string> | null {
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
  const root = asSecRecord(payload);
  const factsRoot = asSecRecord(root?.facts);
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
    const conceptRoot = asSecRecord(rawConcepts);
    if (!conceptRoot) continue;

    for (const [concept, rawFact] of Object.entries(conceptRoot)) {
      if (concepts && !concepts.has(concept.toUpperCase())) continue;
      const fact = asSecRecord(rawFact);
      const unitsRoot = asSecRecord(fact?.units);
      if (!fact || !unitsRoot) continue;

      for (const [unit, rawObservations] of Object.entries(unitsRoot)) {
        if (units && !units.has(unit.toUpperCase())) continue;
        if (!Array.isArray(rawObservations)) continue;

        for (const rawObservation of rawObservations) {
          const observation = asSecRecord(rawObservation);
          if (!observation) continue;
          const periodEnd = normalizeSecDate(observation.end);
          const periodStart = normalizeSecDate(observation.start);
          const filedAt = normalizeSecDate(observation.filed);
          const accessionNumber =
            typeof observation.accn === "string" ? observation.accn : "";
          const form =
            typeof observation.form === "string" ? observation.form : "";
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
              typeof observation.frame === "string"
                ? observation.frame
                : undefined,
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

export const normalizeCompanyFacts = normalizeSecCompanyFacts;

export async function getSecCompanyFacts(
  query: SecCompanyFactsQuery,
  dependencies: SecEdgarDependencies = {}
): Promise<SecCompanyFact[]> {
  if (!query.cik && !query.ticker) throw new Error("ticker or cik is required");
  assertOptionalSecDate(query.filedFrom, "filedFrom");
  assertOptionalSecDate(query.filedTo, "filedTo");
  assertOptionalSecDate(query.periodFrom, "periodFrom");
  assertOptionalSecDate(query.periodTo, "periodTo");

  const tickerCik = query.ticker
    ? await resolveCik(query.ticker, dependencies)
    : null;
  if (query.ticker && !tickerCik) return [];
  const cik = query.cik ? normalizeCik(query.cik) : tickerCik!;
  if (tickerCik && tickerCik !== cik) {
    throw new Error("ticker and CIK resolve to different issuers");
  }
  const payload = await fetchSecJson(
    `${SEC_FACTS_URL}CIK${cik}.json`,
    dependencies
  );
  return normalizeSecCompanyFacts(
    payload,
    query,
    (dependencies.now ?? (() => new Date()))()
  );
}

export const getCompanyFacts = getSecCompanyFacts;
