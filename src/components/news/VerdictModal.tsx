"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { SentimentLabel } from "@/components/shared/SentimentLabel";

export type VerdictDriver = {
  text: string;
  sentiment: "Positive" | "Negative" | "Neutral";
};

export type NewsVerdict = {
  overallSentiment: "Positive" | "Negative" | "Neutral" | "Mixed";
  sentimentScore: number;
  confidence?: "High" | "Medium" | "Low";
  summary: string;
  keyDrivers: VerdictDriver[];
  risks: string[];
  analyzedAt?: string;
  articleCount?: number;
  sourceWindowDays?: number;
};

function driverDot(sentiment: VerdictDriver["sentiment"]): string {
  if (sentiment === "Positive") return "bg-green-600 dark:bg-green-500";
  if (sentiment === "Negative") return "bg-red-700 dark:bg-red-500";
  return "bg-gray-400 dark:bg-gray-500";
}

function formatScore(score: number): string {
  const rounded = Math.round(score * 100) / 100;
  return rounded > 0 ? `+${rounded.toFixed(2)}` : rounded.toFixed(2);
}

function formatAnalyzedAt(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// -1..1 mapped onto the track width so the marker reads as a position between
// bearish and bullish rather than a magnitude bar growing from the left edge.
function ScoreMeter({ score }: { score: number }) {
  const clamped = Math.max(-1, Math.min(1, score));
  const position = ((clamped + 1) / 2) * 100;
  return (
    <div className="space-y-1.5">
      <div className="relative h-2 rounded-full bg-muted">
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow"
          style={{ left: `${position}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Bearish</span>
        <span>Neutral</span>
        <span>Bullish</span>
      </div>
    </div>
  );
}

export function VerdictModal({
  verdict,
  ticker,
  onClose,
}: {
  verdict: NewsVerdict | null;
  ticker?: string;
  onClose: () => void;
}) {
  // Portal target only exists on the client; gate the portal on mount so SSR
  // and the first hydration pass render nothing (the modal is always opened by
  // a post-mount user interaction anyway).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!verdict) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [verdict, onClose]);

  if (!verdict || !mounted) return null;

  const analyzedOn = formatAnalyzedAt(verdict.analyzedAt);
  const meta = [
    analyzedOn ? `Analyzed ${analyzedOn}` : null,
    verdict.articleCount ? `${verdict.articleCount} articles` : null,
    verdict.sourceWindowDays ? `${verdict.sourceWindowDays}-day window` : null,
  ].filter(Boolean);

  // Same portal rationale as NewsModal: `position: fixed` would otherwise be
  // captured by the nearest `backdrop-filter` ancestor (the .glass-card panel).
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-xl animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`AI verdict${ticker ? ` for ${ticker}` : ""}`}
        className="relative w-full max-w-lg rounded-2xl border border-white/50 dark:border-white/10 bg-white/80 dark:bg-card/85 backdrop-blur-xl shadow-2xl p-8 animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2 pr-6">
          AI verdict{ticker ? ` · ${ticker}` : ""}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm mb-5 pr-6">
          <SentimentLabel
            sentiment={verdict.overallSentiment}
            className="text-base font-semibold"
          />
          <span className="text-muted-foreground">
            score {formatScore(verdict.sentimentScore)}
          </span>
          {verdict.confidence && (
            <span className="text-muted-foreground">
              {verdict.confidence} confidence
            </span>
          )}
        </div>

        <div className="max-h-[55vh] overflow-y-auto pr-1 space-y-6">
          <ScoreMeter score={verdict.sentimentScore} />

          <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
            {verdict.summary}
          </p>

          {verdict.keyDrivers.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Key drivers
              </h3>
              <ul className="space-y-2.5">
                {verdict.keyDrivers.map((driver, i) => (
                  <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                    <span
                      aria-hidden
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${driverDot(driver.sentiment)}`}
                    />
                    <span>
                      <span className="sr-only">{driver.sentiment}: </span>
                      {driver.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {verdict.risks.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Risks to watch
              </h3>
              <ul className="space-y-2 text-sm leading-relaxed list-disc pl-4 marker:text-muted-foreground">
                {verdict.risks.map((risk, i) => (
                  <li key={i}>{risk}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {meta.length > 0 && (
          <p className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
            {meta.join(" · ")}
          </p>
        )}

        <p className="mt-2 text-xs text-muted-foreground">
          AI-generated from recent news coverage. Not investment advice.
        </p>
      </div>
    </div>,
    document.body
  );
}
