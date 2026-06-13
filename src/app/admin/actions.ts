"use server";

import { DataAPIClient } from "@datastax/astra-db-ts";
import { CompanyForm, formSchema } from "./schema";
import {
  ASTRA_DB_API_ENDPOINT,
  ASTRA_DB_APPLICATION_TOKEN,
  hasAstra,
} from "@/lib/config";
import { guard, isAdmin } from "@/lib/guard";

export async function postCompany(
  data: CompanyForm
): Promise<{ ok: boolean; message: string }> {
  // Writing to the database is privileged: require an allowlisted admin and
  // rate-limit even them.
  if (!(await isAdmin())) {
    return { ok: false, message: "You are not authorized to add companies." };
  }

  const access = await guard("admin", { limit: 20, windowSec: 60 });
  if (!access.ok) {
    return {
      ok: false,
      message:
        access.reason === "unauthorized"
          ? "Please sign in to manage companies."
          : `Too many requests. Try again in ${access.retryAfterSec}s.`,
    };
  }

  const parsed = formSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, message: "Invalid company data." };
  }

  if (!hasAstra) {
    return {
      ok: false,
      message:
        "Astra DB is not configured. Set ASTRA_DB_APPLICATION_TOKEN and ASTRA_DB_API_ENDPOINT in .env.local.",
    };
  }

  try {
    const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN!);
    const db = client.db(ASTRA_DB_API_ENDPOINT!);
    const collection = db.collection("companies");
    await collection.insertOne(parsed.data);
    return { ok: true, message: `${parsed.data.ticker} added.` };
  } catch (error) {
    console.error("Failed to insert company:", error);
    return { ok: false, message: "Failed to save company to Astra DB." };
  }
}
