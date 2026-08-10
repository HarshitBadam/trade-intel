const NON_SYMBOL_NAMESPACES = new Set([
  "entity",
  "instrument",
  "issuer",
  "name",
  "security",
  "subject",
  "ticker",
]);

const VENUE_PREFIXES = new Set([
  "AMEX",
  "ASX",
  "NASDAQ",
  "NYSE",
  "NYSEARCA",
  "OTC",
]);

/**
 * Canonicalizes provider ticker spellings without confusing internal entity
 * identifiers (for example `ticker:MQG`) with traded symbols.
 */
export function canonicalInstrumentAlias(
  value: string | undefined
): string | null {
  if (!value) return null;
  let normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!normalized) return null;
  normalized = normalized.replace(/^\$/, "").replace(/\s+/g, "");

  const separator = normalized.indexOf(":");
  if (separator > 0) {
    const prefix = normalized.slice(0, separator);
    if (NON_SYMBOL_NAMESPACES.has(prefix.toLowerCase())) return null;
    if (VENUE_PREFIXES.has(prefix)) normalized = normalized.slice(separator + 1);
  }

  normalized = normalized
    .replace(/\.(?:AX|ASX)$/i, "")
    .replace(/[^A-Z0-9.^=-]/g, "");
  return normalized || null;
}

export function canonicalInstrumentAliases(
  values: readonly (string | undefined)[]
): string[] {
  return [
    ...new Set(
      values
        .map(canonicalInstrumentAlias)
        .filter((value): value is string => value !== null)
    ),
  ];
}

export function instrumentAliasesOverlap(
  left: readonly (string | undefined)[],
  right: readonly (string | undefined)[]
): boolean {
  const leftAliases = new Set(canonicalInstrumentAliases(left));
  if (leftAliases.size === 0) return false;
  return canonicalInstrumentAliases(right).some((alias) =>
    leftAliases.has(alias)
  );
}

export function aliasesForListedEntity(entity: {
  ticker?: string;
  market?: string;
}): string[] {
  if (!entity.ticker) return [];
  if (entity.market === "au") {
    return [
      entity.ticker,
      `ASX:${entity.ticker}`,
      `${entity.ticker}.AX`,
    ];
  }
  return [entity.ticker];
}
