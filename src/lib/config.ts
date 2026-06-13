/**
 * Centralised runtime configuration + feature detection.
 *
 * Every external integration is OPTIONAL. When its credentials are absent the
 * app falls back to deterministic demo data (see src/data/fallbacks.ts) and
 * never makes a billable API call. This is the backbone of the project's
 * cost-safety model: no key configured => no spend possible.
 *
 * IMPORTANT: never read process.env for secrets in client components. These
 * values are only safe because this module is imported exclusively from server
 * code (server actions, route handlers, server components, middleware).
 */

// Hard compile-time guard: if any client component ever imports this module,
// the build fails instead of silently inlining secrets into the browser bundle.
// (`server-only` throws only in client bundles, not in node/edge runtimes, so
// middleware importing this stays fine.)
import "server-only";

export const isProd = process.env.NODE_ENV === "production";

// ── Market data (Polygon.io) ────────────────────────────────────────────────
// Server-only. The legacy NEXT_PUBLIC_ variant has been removed: anything with
// that prefix is inlined into the client bundle and would leak the key.
export const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const rawPolygon = Boolean(POLYGON_API_KEY);

// ── Astra DB (news + companies) ─────────────────────────────────────────────
export const ASTRA_DB_APPLICATION_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;
export const ASTRA_DB_API_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
export const ASTRA_DB_NEWS_COLLECTION =
  process.env.ASTRA_DB_NEWS_COLLECTION ?? "prototype_db_v2";
const rawAstra = Boolean(
  ASTRA_DB_APPLICATION_TOKEN && ASTRA_DB_API_ENDPOINT
);

// ── Langflow (StockSage AI chat → OpenAI) ───────────────────────────────────
export const LANGFLOW_BASE_URL = process.env.LANGFLOW_BASE_URL;
export const LANGFLOW_FLOW_ID = process.env.LANGFLOW_FLOW_ID;
export const LANGFLOW_API_KEY = process.env.LANGFLOW_API_KEY;
const rawLangflow = Boolean(
  LANGFLOW_BASE_URL && LANGFLOW_FLOW_ID && LANGFLOW_API_KEY
);

// ── Auth (NextAuth / Auth.js) ───────────────────────────────────────────────
export const hasAuthSecret = Boolean(
  process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
);
export const hasGoogle = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);
export const hasApple = Boolean(
  process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET
);
/** Auth is "active" only when a secret and at least one provider are present. */
export const authConfigured = hasAuthSecret && (hasGoogle || hasApple);

/**
 * Whether unauthenticated visitors must be redirected to /login.
 *
 * Secure-by-default in production: if auth is configured we always enforce it.
 * In development (or before OAuth is set up) we stay open so the demo runs with
 * zero configuration — but expensive actions remain rate-limited and only ever
 * touch mock data unless provider keys are also present.
 */
export const enforceAuth = authConfigured;

// ── Billable capability (cost-safety backstop) ──────────────────────────────
// Live (paid) API calls are only permitted when EITHER we're not in production,
// OR authentication is actually being enforced. This guarantees a production
// deploy can never be simultaneously open AND spending money: if auth isn't
// enforced in prod, every integration silently falls back to mock data (the app
// stays up — priority #2 — but cannot incur cost — priority #1).
const liveAllowed = !isProd || enforceAuth;

export const hasPolygon = rawPolygon && liveAllowed;
export const hasAstra = rawAstra && liveAllowed;
export const hasLangflow = rawLangflow && liveAllowed;

// Loud warning for the dangerous misconfiguration: billable keys present in
// production but auth not enforced (e.g. you added data keys before finishing
// OAuth setup). We degrade to mock data rather than spend; this surfaces why.
if (isProd && (rawPolygon || rawAstra || rawLangflow) && !enforceAuth) {
  console.error(
    "[TradeIntel] SECURITY: Provider keys are set in production but authentication " +
      "is NOT enforced (missing AUTH_SECRET and/or Google/Apple credentials). " +
      "Live API calls are DISABLED (serving mock data) to prevent unauthenticated " +
      "cost. Configure auth to enable live data."
  );
}

// ── Admin access control ────────────────────────────────────────────────────
// Comma-separated allowlist of emails permitted to use the /admin page (which
// writes to Astra DB). When unset, admin is open in dev but locked in prod.
const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return !isProd && adminEmails.length === 0; // dev convenience
  if (adminEmails.length === 0) return !isProd;
  return adminEmails.includes(email.toLowerCase());
}

// ── Rate limiting (Upstash Redis) ───────────────────────────────────────────
export const hasUpstash = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
