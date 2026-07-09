export const mockStockData = [
  {
    id: 1,
    companyName: "Apple Inc.",
    stockPrice: 180.25, // done
    priceChange: 8.50, // done
    percentChange: 4.95, // done
    popularityRate: 92, //fake 
    mentions: 15420, // done
    searchVolume: 850000, // fake
    sentimentPercentage: 78, // done
    positiveSentimentPercentage: 78, // done
    negativeSentimentPercentage: 22, // done
    chartData: [ // Done
      { date: "2024-01-01", value: 170 },
      { date: "2024-01-02", value: 172 },
      { date: "2024-01-03", value: 175 },
      { date: "2024-01-04", value: 178 },
      { date: "2024-01-05", value: 180.25 },
    ],
    news: [] // Done
  },
  {
    id: 2,
    companyName: "Tesla Inc.",

    stockPrice: 675.30,
    priceChange: -15.20,
    percentChange: -2.20,
    popularityRate: 88,
    mentions: 12800,
    searchVolume: 720000,
    sentimentPercentage: 65,
    positiveSentimentPercentage: 65,
    negativeSentimentPercentage: 35,
    chartData: [
      { date: "2024-01-01", value: 690 },
      { date: "2024-01-02", value: 688 },
      { date: "2024-01-03", value: 685 },
      { date: "2024-01-04", value: 680 },
      { date: "2024-01-05", value: 675.30 },
    ]
  },
  {
    id: 3,
    companyName: "NVIDIA Corporation",
    stockPrice: 520.75,
    priceChange: 25.50,
    percentChange: 5.15,
    popularityRate: 85,
    mentions: 9800,
    searchVolume: 450000,
    sentimentPercentage: 82,
    positiveSentimentPercentage: 82,
    negativeSentimentPercentage: 18,
    chartData: [
      { date: "2024-01-01", value: 495 },
      { date: "2024-01-02", value: 500 },
      { date: "2024-01-03", value: 510 },
      { date: "2024-01-04", value: 515 },
      { date: "2024-01-05", value: 520.75 },
    ]
  },
  {
    id: 4,
    companyName: "Microsoft Corp.",
    stockPrice: 390.50,
    priceChange: 15.30,
    percentChange: 4.08,
    popularityRate: 90,
    mentions: 11200,
    searchVolume: 680000,
    sentimentPercentage: 75,
    positiveSentimentPercentage: 75,
    negativeSentimentPercentage: 25,
    chartData: [
      { date: "2024-01-01", value: 375 },
      { date: "2024-01-02", value: 380 },
      { date: "2024-01-03", value: 385 },
      { date: "2024-01-04", value: 388 },
      { date: "2024-01-05", value: 390.50 },
    ]
  }
];