"use server";

import { News } from "@/components/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";

export async function getNews(): Promise<News[]> {
  const client = new DataAPIClient(
    process.env.ASTRA_DB_APPLICATION_TOKEN as string
  );
  const database = client.db(
    process.env.ASTRA_DB_API_ENDPOINT as string
  );
  const table = database.collection<News>("prototype_db_v2");

  const cursor = table.find({ "metadata.ticker": "AAPL" });

  const news: News[] = await cursor.toArray();
  console.log("news from actions", news);

  return news;
}

