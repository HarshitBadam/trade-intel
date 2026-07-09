// Ops tool + test vehicle: run the EXACT production cron handler in-process,
// no server required.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/run-cron.ts
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/run-cron.ts --batch 2 --analyses 1
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/run-cron.ts --unauthorized
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/run-cron.ts --breaker-check
//
// The react-server condition is required because the route imports
// "server-only". Env is parsed from .env.local manually and the knob overrides
// (--batch / --analyses) are written to process.env BEFORE the route is
// dynamically imported, because the handler reads them at request time and the
// store modules read config at import time.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", ".env.local");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    console.warn(`No .env.local at ${envPath}; relying on ambient env.`);
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function breakerCheck(): Promise<void> {
  const breaker = await import("../src/lib/breaker");
  const backend = breaker.breakerBackend();
  console.log(`Breaker backend: ${backend}`);
  await breaker.recordSuccess("polygon"); // clean slate
  console.log(`isOpen after reset: ${await breaker.isOpen("polygon")}`);
  await breaker.recordFailure("polygon");
  await breaker.recordFailure("polygon");
  console.log(`isOpen after 2 failures: ${await breaker.isOpen("polygon")}`);
  await breaker.recordFailure("polygon");
  console.log(`isOpen after 3 failures: ${await breaker.isOpen("polygon")}`);
  await breaker.recordSuccess("polygon");
  console.log(`isOpen after success: ${await breaker.isOpen("polygon")}`);
}

async function main(): Promise<void> {
  loadEnvLocal();

  const args = process.argv.slice(2);
  const unauthorized = args.includes("--unauthorized");

  if (args.includes("--breaker-check")) {
    await breakerCheck();
    return;
  }

  // Knob overrides must land in process.env before importing the route.
  const batch = flagValue(args, "--batch");
  const analyses = flagValue(args, "--analyses");
  if (batch !== undefined) process.env.CRON_BATCH_SIZE = batch;
  if (analyses !== undefined) process.env.CRON_MAX_ANALYSES = analyses;

  if (!process.env.CRON_SECRET) {
    process.env.CRON_SECRET = "local-test-secret";
    console.warn("CRON_SECRET not set; using a temporary local value.");
  }

  const route = await import("../src/app/api/cron/news/route");

  const headers = new Headers();
  if (!unauthorized) {
    headers.set("authorization", `Bearer ${process.env.CRON_SECRET}`);
  }
  const request = new Request("https://local.test/api/cron/news", { headers });

  const startedAt = Date.now();
  const response = await route.GET(request);
  const body = await response.json();
  console.log(`HTTP ${response.status} (wall clock ${Date.now() - startedAt}ms)`);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
