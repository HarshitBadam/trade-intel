"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { SentimentLabel } from "@/components/shared/SentimentLabel";

export type NewsArticle = {
  title: string;
  body: string;
  sentiment?: string;
  source?: string;
  date?: string;
  url?: string;
};

export function NewsModal({
  article,
  onClose,
}: {
  article: NewsArticle | null;
  onClose: () => void;
}) {
  // Portal target only exists on the client; gate the portal on mount so SSR
  // and the first hydration pass render nothing (the modal is always opened by
  // a post-mount user interaction anyway).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!article) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [article, onClose]);

  if (!article || !mounted) return null;

  const hasLink = !!article.url && article.url !== "#";

  // Render through a portal on <body> so the overlay always covers the viewport.
  // Otherwise `position: fixed` is captured by the nearest ancestor with a
  // `backdrop-filter` (our dark-mode `.glass-card` panels), which would trap the
  // modal inside that panel instead of centering it on screen.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-xl animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
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

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mb-3 pr-6">
          {article.sentiment && <SentimentLabel sentiment={article.sentiment} />}
          {article.date && <span>{article.date}</span>}
          {article.source && (
            <span className="font-semibold text-foreground/70">
              {article.source}
            </span>
          )}
        </div>

        <h2 className="text-2xl font-bold font-serif leading-snug mb-4">
          {article.title}
        </h2>

        <p className="text-sm text-muted-foreground leading-relaxed max-h-[50vh] overflow-y-auto whitespace-pre-line">
          {article.body}
        </p>

        {hasLink && (
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-6 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Read full article
          </a>
        )}
      </div>
    </div>,
    document.body
  );
}
