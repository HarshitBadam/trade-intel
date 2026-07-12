import type { EvidenceSource, SourceKind } from "./types";

export type EvidenceInput = {
  kind: SourceKind;
  title: string;
  outlet: string;
  publishedAt?: string;
  url: string;
  excerpt: string;
  score?: number;
  entityIds?: string[];
  criteria?: string[];
  retrievedAt?: string;
  queryId?: string;
};

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sourceKey(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function outletFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}

export function createEvidenceSources(
  inputs: EvidenceInput[],
  limit = 12
): EvidenceSource[] {
  const seen = new Set<string>();
  const sources: EvidenceSource[] = [];

  for (const input of inputs) {
    const url = safeSourceUrl(input.url);
    if (!url) continue;
    const key = sourceKey(url);
    if (seen.has(key)) continue;
    const title = compact(input.title, 180);
    const excerpt = compact(input.excerpt, 650);
    if (!title || !excerpt) continue;
    seen.add(key);
    sources.push({
      id: `S${sources.length + 1}`,
      kind: input.kind,
      title,
      outlet: compact(input.outlet, 80) || outletFromUrl(url),
      publishedAt: input.publishedAt
        ? compact(input.publishedAt, 40)
        : undefined,
      url,
      excerpt,
      score: input.score,
      entityIds: input.entityIds ?? [],
      criteria: input.criteria ?? [],
      retrievedAt: input.retrievedAt ?? new Date().toISOString(),
      queryId: input.queryId,
    });
    if (sources.length >= limit) break;
  }

  return sources;
}

function stripMarkdownLinks(text: string): string {
  return text
    .replace(/^\s*\[[^\]]+\]:\s*<?https?:\/\/\S+>?\s*$/gim, "")
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]+\]/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
}

function markdownLabel(value: string): string {
  return value.replace(/\\/g, "").replace(/[\[\]]/g, "").trim() || "Source";
}

function markdownUrl(value: string): string {
  return value.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function normalizeCitationSyntax(text: string): string {
  return text
    .replace(
      /[【(]((?:S\d{1,3})(?:\s*,\s*S\d{1,3})*)[】)]/g,
      "[$1]"
    )
    .replace(/[【\[]\s*Validated Quote\s*[】\]]/gi, "");
}

function normalizeBareSourceIds(
  text: string,
  sources: EvidenceSource[]
): string {
  const known = new Set(sources.map((source) => source.id));
  return text.replace(
    /(^|[^\[\w])(S\d{1,3})(?![\w\]])/g,
    (match, prefix: string, id: string) =>
      known.has(id) ? `${prefix}[${id}]` : match
  );
}

export function validCitationUrls(
  text: string,
  sources: EvidenceSource[]
): string[] {
  const ids = new Set(
    [
      ...normalizeBareSourceIds(
        stripMarkdownLinks(normalizeCitationSyntax(text)),
        sources
      ).matchAll(/\b(S\d{1,3})\b/g),
    ].map(
      (match) => match[1]
    )
  );
  return sources
    .filter((source) => ids.has(source.id))
    .map((source) => markdownUrl(source.url));
}

export function stripUntrustedLinks(text: string): string {
  return stripMarkdownLinks(text)
    .replace(/\[(?:S\d{1,3})(?:\s*,\s*S\d{1,3})*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
}

export function stripTickerCitationMarkers(
  text: string,
  tickers: string[]
): string {
  const known = new Set(tickers.map((ticker) => ticker.toUpperCase()));
  return text.replace(/\[([A-Z][A-Z0-9.-]{0,9})\]/g, (match, ticker) =>
    known.has(ticker.toUpperCase()) ? "" : match
  );
}

export function sanitizeExternalCitations(text: string): {
  text: string;
  citationUrls: string[];
} {
  const urls = new Set<string>();
  const sanitized = text
    .replace(/^\s*\[[^\]]+\]:\s*<?\S+>?\s*$/gim, "")
    .replace(
      /!?\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g,
      (_match, label: string, target: string) => {
        const safe = safeSourceUrl(target.replace(/^<|>$/g, "").trim());
        if (!safe) return markdownLabel(label);
        const href = markdownUrl(safe);
        urls.add(href);
        return `[${markdownLabel(label)}](${href})`;
      }
    )
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();

  return { text: sanitized, citationUrls: [...urls] };
}

export function expandValidCitations(
  text: string,
  sources: EvidenceSource[]
): string {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return normalizeBareSourceIds(
    stripMarkdownLinks(normalizeCitationSyntax(text)),
    sources
  )
    .replace(
      /\[((?:S\d{1,3})(?:\s*,\s*S\d{1,3})+)\]/g,
      (_match, group: string) =>
        group
          .split(/\s*,\s*/)
          .map((id) => {
            const source = byId.get(id);
            return source
              ? `[${markdownLabel(source.outlet)}](${markdownUrl(source.url)})`
              : "";
          })
          .filter(Boolean)
          .join(", ")
    )
    .replace(/\[(S\d{1,3})\]/g, (_match, id: string) => {
      const source = byId.get(id);
      if (!source) return "";
      return `[${markdownLabel(source.outlet)}](${markdownUrl(source.url)})`;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
}
