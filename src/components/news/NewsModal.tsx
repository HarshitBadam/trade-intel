"use client";

import { SentimentLabel } from "@/components/shared/SentimentLabel";
import { ModalFrame } from "@/components/shared/ModalFrame";
import { useModalDismiss } from "@/hooks/useModalDismiss";

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
  const mounted = useModalDismiss(!!article, onClose);

  if (!article || !mounted) return null;

  const hasLink = !!article.url && article.url !== "#";

  return (
    <ModalFrame onClose={onClose}>
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
    </ModalFrame>
  );
}
