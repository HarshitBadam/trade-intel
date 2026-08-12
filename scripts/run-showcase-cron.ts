import { loadEnvLocal } from "./env";

async function main(): Promise<void> {
  loadEnvLocal({ required: true });
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
