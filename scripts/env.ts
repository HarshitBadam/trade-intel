import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LoadEnvOptions = {
  required?: boolean;
  warnIfMissing?: boolean;
};

const envPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env.local"
);

export function loadEnvLocal(options: LoadEnvOptions = {}): void {
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (error) {
    if (options.required) throw error;
    if (options.warnIfMissing) {
      console.warn(`No .env.local at ${envPath}; relying on ambient env.`);
    }
    return;
  }

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
