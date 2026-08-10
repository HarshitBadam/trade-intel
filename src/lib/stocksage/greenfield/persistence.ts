import "server-only";

import { hasUpstash } from "@/lib/config";
import type { ResearchPersistence } from "./research";
import {
  InMemoryResearchPersistence,
  UpstashResearchPersistence,
} from "./research";

let persistence: ResearchPersistence | undefined;

/**
 * Production uses durable Redis state when configured. Local/test execution
 * keeps one process-level in-memory store rather than recreating it per turn.
 */
export async function defaultResearchPersistence(): Promise<ResearchPersistence> {
  if (persistence) return persistence;
  if (!hasUpstash) {
    persistence = new InMemoryResearchPersistence();
    return persistence;
  }
  const { Redis } = await import("@upstash/redis");
  persistence = new UpstashResearchPersistence(Redis.fromEnv());
  return persistence;
}
