"use client";

import { useState } from "react";
import { Progress } from "@/components/ui/progress";
import { NewsCard } from "./NewsCard";
import { Bar } from "./Bar";
import { NewsModal, type NewsArticle } from "./NewsModal";

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
    ticker: string;
    description: string;
    event: string;
    /** ISO timestamp written by the Langflow Expander; optional for older docs. */
    ingested_at?: string;
  };
};

/** Provenance of the news currently shown, used to drive the UI badge. */
export type NewsStatus = "fresh" | "analyzing" | "live" | "sample";

interface RecentInfluentialProps {
  news?: News[];
  status?: NewsStatus;
  updatedAt?: string;
  positiveSentimentPercentage: number;
  negativeSentimentPercentage: number;
}

// Human "x ago" label from an ISO timestamp, used by the `fresh` badge.
function timeAgo(iso?: string): string {
  if (!iso) return "";
  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusBadge({
  status,
  updatedAt,
}: {
  status?: NewsStatus;
  updatedAt?: string;
}) {
  if (!status) return null;

  const config: Record<
    NewsStatus,
    { label: string; dot: string; text: string }
  > = {
    fresh: {
      label: `AI analysis${updatedAt ? ` · updated ${timeAgo(updatedAt)}` : ""}`,
      dot: "bg-green-500",
      text: "text-green-700",
    },
    analyzing: {
      label: "Analyzing latest news…",
      dot: "bg-yellow-500 animate-pulse",
      text: "text-yellow-700",
    },
    live: {
      label: "Live headlines",
      dot: "bg-blue-500",
      text: "text-blue-700",
    },
    sample: {
      label: "Sample data",
      dot: "bg-gray-400",
      text: "text-gray-500",
    },
  };

  const { label, dot, text } = config[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function NewsCardSkeleton() {
  return (
    <div className="flex items-start space-x-4 py-4 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-gray-200" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/2 rounded bg-gray-200" />
        <div className="h-3 w-full rounded bg-gray-200" />
        <div className="h-3 w-2/3 rounded bg-gray-200" />
      </div>
    </div>
  );
}

export function RecentInfluential({ 
  news = [], 
  status,
  updatedAt,
  positiveSentimentPercentage, 
  negativeSentimentPercentage 
}: RecentInfluentialProps) {
  const [selected, setSelected] = useState<NewsArticle | null>(null);

  // The remaining share is neutral sentiment; including it makes the bar
  // segments sum to 100 (and silences the Bar validation warning).
  const neutralSentimentPercentage = Math.max(
    0,
    100 - positiveSentimentPercentage - negativeSentimentPercentage
  );
  const sentimentBreakdown = [
    {
      percentage: positiveSentimentPercentage,
      color: "bg-sidebar-accent-foreground",
      sentiment: "Positive",
    },
    {
      percentage: neutralSentimentPercentage,
      color: "bg-muted",
      sentiment: "Neutral",
    },
    {
      percentage: negativeSentimentPercentage,
      color: "bg-muted-foreground",
      sentiment: "Negative",
    },
  ];

  return (
    <div className="w-full rounded-lg p-6 shadow-md flex flex-col h-full">
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

      {(news.length > 0 || status === "analyzing") && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-6 gap-3">
            <h2 className="text-xl font-bold">Recent Influential</h2>
            <StatusBadge status={status} updatedAt={updatedAt} />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="flex relative">
              <div className="flex-1 flex flex-col divide-y divide-border/70 overflow-x-hidden">
                {status === "analyzing" && (
                  <NewsCardSkeleton />
                )}
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
                    onClick={() =>
                      setSelected({
                        title: news.metadata.event || news.metadata.title,
                        body:
                          news.metadata.key_observations ||
                          news.metadata.description ||
                          news.page_content,
                        sentiment: news.metadata.sentiment,
                        source: news.metadata.source,
                        date: news.metadata.publication_date,
                        url: news.metadata.url,
                      })
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <NewsModal article={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
