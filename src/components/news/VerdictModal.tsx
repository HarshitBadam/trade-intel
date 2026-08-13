"use client";

import { SentimentLabel } from "@/components/shared/SentimentLabel";
import { ModalFrame } from "@/components/shared/ModalFrame";
import { useModalDismiss } from "@/hooks/useModalDismiss";

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

function ScoreMeter({ score }: { score: number }) {
  const clamped = Math.max(-1, Math.min(1, score));
  const position = ((clamped + 1) / 2) * 100;
  return (
    <div className="space-y-1.5 pt-1">
      <div className="relative h-2">
        <div className="absolute inset-0 overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-foreground"
            style={{ width: `${position}%` }}
          />
        </div>
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
  const mounted = useModalDismiss(!!verdict, onClose);

  if (!verdict || !mounted) return null;

  const analyzedOn = formatAnalyzedAt(verdict.analyzedAt);
  const meta = [analyzedOn ? `Analyzed ${analyzedOn}` : null].filter(Boolean);

  return (
    <ModalFrame
      onClose={onClose}
      frameProps={{
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `AI verdict${ticker ? ` for ${ticker}` : ""}`,
      }}
    >
      {ticker && (
        <div className="text-lg font-bold mb-2 pr-6">{ticker}</div>
      )}

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
          {meta.join(", ")}
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        AI-generated from recent news coverage. Not investment advice.
      </p>
    </ModalFrame>
  );
}
