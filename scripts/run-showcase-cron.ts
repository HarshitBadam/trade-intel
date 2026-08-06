import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(here, "..", ".env.local"), "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;

  if (!appUrl || !secret) {
    throw new Error("APP_URL and CRON_SECRET are required");
  }

  const response = await fetch(`${appUrl}/api/cron/showcase`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await response.text();
  console.log(body);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
