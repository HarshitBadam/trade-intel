import type { EvidenceSource, SourceKind } from "./types";

export type EvidenceInput = {
  kind: SourceKind;
  title: string;
  outlet: string;
  publishedAt?: string;
  url: string;
  excerpt: string;
};

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
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
    if (!url || seen.has(url)) continue;
    const title = compact(input.title, 180);
    const excerpt = compact(input.excerpt, 650);
    if (!title || !excerpt) continue;
    seen.add(url);
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

export function validCitationUrls(
  text: string,
  sources: EvidenceSource[]
): string[] {
  const ids = new Set(
    [...stripMarkdownLinks(text).matchAll(/\[(S\d{1,3})\]/g)].map(
      (match) => match[1]
    )
  );
  return sources
    .filter((source) => ids.has(source.id))
    .map((source) => markdownUrl(source.url));
}

export function stripUntrustedLinks(text: string): string {
  return stripMarkdownLinks(text)
    .replace(/\[S\d{1,3}\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
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
  return stripMarkdownLinks(text)
    .replace(/\[(S\d{1,3})\]/g, (_match, id: string) => {
      const source = byId.get(id);
      if (!source) return "";
      return `[${markdownLabel(source.outlet)}](${markdownUrl(source.url)})`;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();
}
