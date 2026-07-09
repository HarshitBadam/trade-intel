export async function getStockCandles(symbol: string) {
  const response = await fetch(
    `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/2024-03-15/2025-03-15?adjusted=true&sort=asc&limit=50000&apiKey=${process.env.NEXT_PUBLIC_POLYGON_API_KEY}`,
    { cache: "no-store" }
  );

  const data = await response.json();
  if (!data.results) {
    return null
  }
  const chartData = data.results.map((candle: any) => {
    return {
      date: candle.t,
      mobile: candle.c,
      desktop: candle.o,
    };
  });
  return chartData;
}
