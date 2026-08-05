import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@upstash/qstash";

function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", ".env.local");
  const raw = readFileSync(envPath, "utf8");

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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  loadEnvLocal();

  const qstashUrl = required("QSTASH_URL").replace(/\/$/, "");
  const qstashToken = required("QSTASH_TOKEN");
  const appUrl = required("APP_URL").replace(/\/$/, "");
  const cronSecret = required("CRON_SECRET");

  const client = new Client({
    baseUrl: qstashUrl,
    token: qstashToken,
    enableTelemetry: false,
  });

  for (const scheduleId of [
    "tradeintel-news-cron",
    "tradeintel-keep-warm",
    "tradeintel-showcase-cron",
    "tradeintel-maintenance-cron",
  ]) {
    await client.schedules.delete(scheduleId).catch(() => undefined);
  }

  const showcase = await client.schedules.create({
    scheduleId: "tradeintel-showcase-cron",
    destination: `${appUrl}/api/cron/showcase`,
    cron: "0 * * * *",
    method: "GET",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "X-TradeIntel-Scheduler": "qstash",
    },
    retries: 1,
    retryDelay: "min(30, pow(2, retried))",
    timeout: "280s",
    flowControl: {
      key: "tradeintel-showcase-cron",
      parallelism: 1,
    },
    redact: { header: ["Authorization"] },
    label: "tradeintel-showcase",
  });

  const maintenance = await client.schedules.create({
    scheduleId: "tradeintel-maintenance-cron",
    destination: `${appUrl}/api/cron/maintenance`,
    cron: "15 13 * * *",
    method: "GET",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "X-TradeIntel-Scheduler": "qstash",
    },
    retries: 1,
    retryDelay: "min(60, pow(2, retried) * 10)",
    timeout: "60s",
    flowControl: {
      key: "tradeintel-maintenance-cron",
      parallelism: 1,
    },
    redact: { header: ["Authorization"] },
    label: "tradeintel-maintenance",
  });

  const schedules = await client.schedules.list();
  const managed = schedules
    .filter((schedule) =>
      [showcase.scheduleId, maintenance.scheduleId].includes(schedule.scheduleId)
    )
    .map((schedule) => ({
      scheduleId: schedule.scheduleId,
      cron: schedule.cron,
      destination: schedule.destination,
      retries: schedule.retries,
      paused: schedule.isPaused,
      nextScheduleTime: schedule.nextScheduleTime
        ? new Date(schedule.nextScheduleTime).toISOString()
        : null,
    }));

  console.log(JSON.stringify({ ok: true, schedules: managed }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
