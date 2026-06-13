import "server-only";

import { headers } from "next/headers";
import { auth } from "@/auth";
import {
  authConfigured,
  enforceAuth,
  isAdminEmail,
} from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Single entry point that every expensive / billable server action must call
 * before doing any external work. It combines:
 *   1. authentication enforcement (when auth is configured)
 *   2. per-identity rate limiting (user id when known, else client IP)
 *
 * This is the server-side backstop: even if the UI is bypassed and an action is
 * invoked directly, it cannot run unauthenticated or be hammered.
 */

async function getClientIp(): Promise<string> {
  const h = await headers();
  // Prefer platform-populated headers that a client cannot spoof. On Vercel,
  // `x-real-ip` is set to the true client IP. The leftmost `x-forwarded-for`
  // entry is attacker-controlled, so we only use it as a last resort. IP-based
  // limiting is best-effort and is never the sole cost control (see config.ts).
  const realIp = h.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "anonymous";
  return "anonymous";
}

export type GuardOptions = {
  /** max requests per window for a single identity */
  limit: number;
  /** window length in seconds */
  windowSec: number;
  /** require a logged-in user when auth is configured (default: true) */
  requireAuth?: boolean;
};

export type GuardResult =
  | { ok: true; identity: string; email: string | null }
  | { ok: false; reason: "unauthorized" | "rate_limited"; retryAfterSec?: number };

export async function guard(
  namespace: string,
  opts: GuardOptions
): Promise<GuardResult> {
  const session = authConfigured ? await auth() : null;
  const email = session?.user?.email ?? null;
  const userId = session?.user?.id ?? email;

  if (enforceAuth && (opts.requireAuth ?? true) && !userId) {
    return { ok: false, reason: "unauthorized" };
  }

  const identity = userId ?? (await getClientIp());
  const res = await rateLimit(namespace, identity, opts.limit, opts.windowSec);

  if (!res.success) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterSec: Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
    };
  }

  return { ok: true, identity, email };
}

/** Whether the current request is allowed to use admin (DB-writing) features. */
export async function isAdmin(): Promise<boolean> {
  const session = authConfigured ? await auth() : null;
  return isAdminEmail(session?.user?.email);
}
