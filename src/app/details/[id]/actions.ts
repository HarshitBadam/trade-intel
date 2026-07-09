"use server";

import { restClient } from "@polygon.io/client-js";
import { News } from "@/components/RecentInfluential";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { StockData } from "./page";

export async function searchStocks(query: string) {
  try {
    const rest = restClient(process.env.NEXT_PUBLIC_POLYGON_API_KEY);
    const searchResults = await rest.reference.tickers({
      search: query,
      market: "stocks",
      active: "true",
      limit: 5
    });

    if (!searchResults.results) {
      return [];
    }

    // Get details for each stock found
    const stockDetails = await Promise.all(
      searchResults.results.map(async (stock) => {
        try {
          const details = await fetchDetails(stock.ticker);
          return details;
        } catch (error) {
          console.error(`Error fetching details for ${stock.ticker}:`, error);
          return null;
        }
      })
    );

    return stockDetails.filter(stock => stock !== null);
  } catch (error) {
    console.error('Error searching stocks:', error);
    return [];
  }
}

export async function fetchDetails(ticker: string): Promise<StockData> {
  let stock_data;
  try {
    stock_data = await getStockCandles(ticker);
  } catch (e) {
    console.error(e);
  }

  const news = await getNews(ticker);

  return {
    id: ticker,
    companyName: ticker,
    stockPrice: stock_data?.stock_price,
    priceChange: stock_data?.price_change ?? 0,
    percentChange: stock_data?.percent_change ?? 0,
    popularityRate: 92,
    mentions: news.mentions,
    searchVolume: 850000,
    sentimentPercentage: news.positiveSentiment,
    positiveSentimentPercentage: news.positiveSentiment,
    negativeSentimentPercentage: news.negativeSentiment,
    chartData: stock_data?.chart_data ?? [],
    news: news.news,
  };
}

async function getNews(ticker: string) {
  const client = new DataAPIClient(
    process.env.ASTRA_DB_APPLICATION_TOKEN as string
  );
  const database = client.db(process.env.ASTRA_DB_API_ENDPOINT as string);
  const table = database.collection<News>("prototype_db_v2");

  console.log(
    process.env.ASTRA_DB_API_ENDPOINT,
    process.env.ASTRA_DB_APPLICATION_TOKEN
  );

  const cursor = table.find({ "metadata.ticker": ticker });

  const news: News[] = await cursor.toArray();
  console.log(news);

  const mentions = news.length;
  const positiveSentiment =
    (news.filter((n) => n.metadata.sentiment === "Positive").length /
      mentions) *
    100;
  const negativeSentiment =
    (news.filter((n) => n.metadata.sentiment === "Negative").length /
      mentions) *
    100;

  return {
    mentions: mentions,
    positiveSentiment: positiveSentiment,
    negativeSentiment: negativeSentiment,
    news: news,
  };
}

async function getStockCandles(ticker: string) {
  const rest = restClient(process.env.NEXT_PUBLIC_POLYGON_API_KEY);
  const stock_data = await rest.stocks.aggregates(
    ticker,
    1,
    "day",
    "2023-01-01",
    "2023-04-14"
  );
  console.log(stock_data);

  if (!stock_data.results) {
    return null;
  }

  return {
    chart_data: stock_data.results.map((candle: any) => {
      return {
        date: new Date(candle.t).toISOString(),
        value: candle.c,
      };
    }),
    stock_price: stock_data.results[0].c,
    price_change: stock_data.results[0].c!! - stock_data.results[1].c!!,
    percent_change:
      ((stock_data.results[0].c!! - stock_data.results[1].c!!) /
        stock_data.results[1].c!!) *
      100,
  };
}
