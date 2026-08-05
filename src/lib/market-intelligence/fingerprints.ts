import { createHash } from "node:crypto";

export const CONTENT_FINGERPRINT_SCHEMA_VERSION = "market-content-v1";
export const RESPONSE_SCHEMA_VERSION = "market-analysis-v1";

export type FingerprintArticle = {
  articleId: string;
  publicationDate: string;
  contentRevision: string;
};

export type ArticleContent = {
  title?: string | null;
  description?: string | null;
  pageContent?: string | null;
};

export type AnalysisFingerprintInput = {
  contentFingerprint: string;
  promptVersion: string;
  model: string;
  responseSchemaVersion?: string;
};

function hash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? trimmed : new Date(timestamp).toISOString();
}

export function createContentRevision(content: ArticleContent): string {
  return hash([
    normalizeText(content.title),
    normalizeText(content.description),
    normalizeText(content.pageContent),
  ]);
}

export function createContentFingerprint(
  ticker: string,
  articles: readonly FingerprintArticle[],
  schemaVersion = CONTENT_FINGERPRINT_SCHEMA_VERSION
): string {
  const canonicalArticles = articles
    .map((article) => [
      article.articleId.trim(),
      normalizeDate(article.publicationDate),
      article.contentRevision.trim(),
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );

  return hash([schemaVersion, ticker.trim().toUpperCase(), canonicalArticles]);
}

export function createAnalysisFingerprint({
  contentFingerprint,
  promptVersion,
  model,
  responseSchemaVersion = RESPONSE_SCHEMA_VERSION,
}: AnalysisFingerprintInput): string {
  return hash([
    contentFingerprint.trim(),
    promptVersion.trim(),
    model.trim(),
    responseSchemaVersion.trim(),
  ]);
}
