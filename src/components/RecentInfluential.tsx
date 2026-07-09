import { Progress } from "@/components/ui/progress";
import { NewsCard } from "./NewsCard";
import { Bar } from "./Bar";

export type News = {
  _id: string;
  page_content: string;
  metadata: {
    title: string;
    source: string;
    publication_date: string;
    importance: string;
    sentiment: string;
    key_observations: string;
    url: string;
    ticket: string;
    description: string;
    event: string;
  };
};

interface RecentInfluentialProps {
  news?: News[];
  positiveSentimentPercentage: number;
  negativeSentimentPercentage: number;
}

export function RecentInfluential({ 
  news = [], 
  positiveSentimentPercentage, 
  negativeSentimentPercentage 
}: RecentInfluentialProps) {
  const sentimentBreakdown = [
    {
      percentage: positiveSentimentPercentage,
      color: "bg-sidebar-accent-foreground",
      sentiment: "Positive",
    },
    { 
      percentage: negativeSentimentPercentage, 
      color: "bg-muted-foreground", 
      sentiment: "Negative" 
    }
  ];

  return (
    <div className="w-full rounded-lg p-6 shadow-md">
      <div className="pb-8">
        <h2 className="text-xl font-bold mb-6">Sentiment Score Gauge</h2>
        <div className="flex justify-center items-center gap-4 pb-3">
          <div className="flex pr-3">
            <div className="text-sm">Positive</div>
            <img src="/upArrow.svg" alt="Positive" className="w-4 h-4 mt-0.5" />
          </div>

          <Progress value={positiveSentimentPercentage} className="" />
          <div className="text-sm">{positiveSentimentPercentage}%</div>
        </div>
        <div className="flex justify-center items-center gap-4 pt-3">
          <div className="flex pr-3">
            <div className="text-sm">Negative</div>
            <img
              src="/downArrow.svg"
              alt="Negative"
              className="w-4 h-4 mt-0.5"
            />
          </div>
          <Progress value={negativeSentimentPercentage} className="" />
          <div className="text-sm">{negativeSentimentPercentage}%</div>
        </div>
      </div>

      <div className="pb-8">
        <h2 className="text-xl font-bold mb-4">Sentiments Breakdown</h2>
        <Bar segments={sentimentBreakdown} height="h-8" />
      </div>

      {news && news.length > 0 && (
        <>
          <h2 className="text-xl font-bold mb-6">Recent Influential</h2>
          <div className="overflow-y-scroll max-h-[340px]">
            <div className="flex relative">
              <div className="flex-1 flex flex-col gap-8 pt-2 overflow-x-hidden">
                {news.map((news) => (
                  <NewsCard
                    key={news._id}
                    id={news._id}
                    username={news.metadata.event}
                    content={news.metadata.key_observations}
                    date={news.metadata.publication_date}
                    significance={news.metadata.importance.toUpperCase()}
                    avatarUrl=""
                    source={news.metadata.source}
                  />
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
