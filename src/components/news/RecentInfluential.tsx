"use client";

import { useEffect, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { NewsCard } from "./NewsCard";
import { Bar } from "./Bar";
import { NewsModal, type NewsArticle } from "./NewsModal";
import { VerdictModal, type NewsVerdict } from "./VerdictModal";

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
    ingested_at?: string;
  };
};

export type NewsStatus =
  | "fresh"
  | "analyzing"
  | "live"
  | "sample"
  | "stale"
  | "unavailable";

interface RecentInfluentialProps {
  news?: News[];
  status?: NewsStatus;
  updatedAt?: string;
  verdict?: NewsVerdict;
  ticker?: string;
  positiveSentimentPercentage: number;
  negativeSentimentPercentage: number;
}

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
  onOpen,
}: {
  status?: NewsStatus;
  updatedAt?: string;
  onOpen?: () => void;
}) {
  if (!status) return null;

  const config: Record<
    NewsStatus,
    { label: string; dot: string; text: string }
  > = {
    fresh: {
      label: `AI analysis${updatedAt ? ` updated ${timeAgo(updatedAt)}` : ""}`,
      dot: "bg-green-500",
      text: "text-green-700 dark:text-green-400",
    },
    stale: {
      label: `Outdated analysis${updatedAt ? `, ${timeAgo(updatedAt)}` : ""}`,
      dot: "bg-amber-500",
      text: "text-amber-700 dark:text-amber-400",
    },
    analyzing: {
      label: "Analyzing latest news",
      dot: "bg-yellow-500",
      text: "text-yellow-700 dark:text-yellow-400",
    },
    live: {
      label: "Live headlines",
      dot: "bg-blue-500",
      text: "text-blue-700 dark:text-blue-400",
    },
    sample: {
      label: "Sample data",
      dot: "bg-gray-400",
      text: "text-gray-500 dark:text-gray-400",
    },
    unavailable: {
      label: "Headlines unavailable",
      dot: "bg-gray-400",
      text: "text-gray-500 dark:text-gray-400",
    },
  };

  const { label, dot, text } = config[status];
  const content = (
    <>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </>
  );

  if (!onOpen) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title="View the full AI verdict"
      className={`inline-flex items-center gap-1.5 rounded-md text-xs font-medium underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-80 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${text}`}
    >
      {content}
    </button>
  );
}

function NewsCardSkeleton() {
  return (
    <div className="flex items-start space-x-4 py-4 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-muted" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/2 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
    </div>
  );
}

export function RecentInfluential({ 
  news = [], 
  status,
  updatedAt,
  verdict,
  ticker,
  positiveSentimentPercentage, 
  negativeSentimentPercentage 
}: RecentInfluentialProps) {
  const [selected, setSelected] = useState<NewsArticle | null>(null);
  const [verdictOpen, setVerdictOpen] = useState(false);

  // Force a repaint after polling because Chromium can retain stale layers under backdrop-filter.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.transform = "translateZ(0)";
    const raf = requestAnimationFrame(() => {
      if (panelRef.current) panelRef.current.style.transform = "";
    });
    return () => cancelAnimationFrame(raf);
  }, [news, status]);

  const neutralSentimentPercentage = Math.max(
    0,
    100 - positiveSentimentPercentage - negativeSentimentPercentage
  );
  const sentimentBreakdown = [
    {
      percentage: positiveSentimentPercentage,
      color: "bg-sidebar-accent-foreground dark:bg-zinc-300",
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
    <div ref={panelRef} className="w-full rounded-lg p-6 glass-card shadow-md flex flex-col h-full">
      <div className="pb-8">
        <div className="flex items-center justify-between mb-6 gap-3">
          <h2 className="text-xl font-bold">Sentiment Score Gauge</h2>
          {status === "analyzing" && (
            <span className="text-xs font-medium text-muted-foreground">
              Updating
            </span>
          )}
        </div>
        <div className="flex justify-center items-center gap-4 pb-3">
          <div className="flex pr-3">
            <div className="text-sm">Positive</div>
            <img src="/upArrow.svg" alt="Positive" className="w-4 h-4 mt-0.5 dark:invert" />
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
              className="w-4 h-4 mt-0.5 dark:invert"
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

      {(news.length > 0 || status === "analyzing" || status === "unavailable") && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-6 gap-3">
            <h2 className="text-xl font-bold">Recent Influential</h2>
            <StatusBadge
              status={status}
              updatedAt={updatedAt}
              onOpen={verdict ? () => setVerdictOpen(true) : undefined}
            />
          </div>
          {/* The cap is needed below lg, where the panel has no bounded parent. */}
          <div className="flex-1 min-h-0 overflow-y-auto max-h-[26rem] lg:max-h-none">
            <div className="flex relative">
              <div className="flex-1 flex flex-col divide-y divide-border/70 overflow-x-hidden">
                {status === "analyzing" && news.length === 0 && (
                  <NewsCardSkeleton />
                )}
                {status === "unavailable" && news.length === 0 && (
                  <p className="py-4 text-sm text-muted-foreground">
                    Live headlines are temporarily unavailable. This usually
                    resolves within a minute, we&apos;ll keep checking.
                  </p>
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
      <VerdictModal
        verdict={verdictOpen ? (verdict ?? null) : null}
        ticker={ticker}
        onClose={() => setVerdictOpen(false)}
      />
    </div>
  );
}
