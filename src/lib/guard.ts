import "server-only";

import { createHash } from "crypto";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { authConfigured, enforceAuth } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";

const RL_SALT = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";

// One-way hash so raw identifiers (Google id, email, IP) never reach an
// external rate-limit store such as Upstash Redis.
function hashIdentity(identity: string): string {
  return createHash("sha256").update(`${RL_SALT}:${identity}`).digest("hex");
}

async function getClientIp(): Promise<string> {
  const h = await headers();
  const realIp = h.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "anonymous";
  return "anonymous";
}

export type GuardOptions = {
  limit: number;
  windowSec: number;
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
  const res = await rateLimit(
    namespace,
    hashIdentity(identity),
    opts.limit,
    opts.windowSec
  );

  if (!res.success) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterSec: Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
    };
  }

  return { ok: true, identity, email };
}
