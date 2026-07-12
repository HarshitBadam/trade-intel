import { RotateCcw, Telescope } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { DeepResearchOffer } from "@/lib/stocksage/types";

export type DeepMessageState = {
  status: "idle" | "pending" | "success" | "failure";
  progress?: "Researching sources";
  text?: string;
  citationUrls?: string[];
  retryable?: boolean;
};

export type ChatMessageModel = {
  id: string;
  sender: "ai" | "user";
  text: string;
  citationUrls?: string[];
  deepResearch?: DeepResearchOffer;
  deepState?: DeepMessageState;
  error?: boolean;
  retryable?: boolean;
};

function CitationChip({
  href,
  children,
  allowedHrefs,
}: {
  href?: string;
  children?: React.ReactNode;
  allowedHrefs?: string[];
}) {
  let domain = "";
  let safeHref = "";
  try {
    if (href) {
      const url = new URL(href);
      if (url.protocol === "http:" || url.protocol === "https:") {
        safeHref = url.toString();
        domain = url.hostname.replace(/^www\./, "");
      }
    }
  } catch {
    safeHref = "";
  }
  const allowed = (allowedHrefs ?? []).some((candidate) => {
    try {
      return new URL(candidate).toString() === safeHref;
    } catch {
      return false;
    }
  });
  if (!safeHref || !allowed) return <span>{children}</span>;
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      title={domain || undefined}
      className="mx-0.5 inline-flex items-center rounded-md bg-muted/70 px-1.5 py-px text-[0.78em] font-medium text-foreground/70 no-underline transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </a>
  );
}

function tidyCitations(text: string): string {
  const link = "\\[[^\\]]+\\]\\((?:[^()]|\\([^()]*\\))*\\)";
  const wrapped = new RegExp(`\\(\\s*(${link})\\s*(?:,[^()]*?)?\\)`, "g");
  const trailingDate = new RegExp(
    `(${link})\\s*\\(\\s*\\d[\\d\\-/.\\s]*\\)`,
    "g"
  );
  return text
    .replace(wrapped, "$1")
    .replace(trailingDate, "$1")
    .replace(/[ \t]+([.,;:])/g, "$1");
}

function MarkdownAnswer({
  text,
  citationUrls,
}: {
  text: string;
  citationUrls?: string[];
}) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <CitationChip href={href} allowedHrefs={citationUrls}>
            {children}
          </CitationChip>
        ),
      }}
    >
      {tidyCitations(text)}
    </ReactMarkdown>
  );
}

export function ChatMessage({
  message,
  onResearch,
  onRetry,
}: {
  message: ChatMessageModel;
  onResearch: (messageId: string) => void;
  onRetry: (messageId: string) => void;
}) {
  const deep = message.deepState;
  const canResearch =
    message.sender === "ai" &&
    message.deepResearch &&
    (!deep || deep.status === "idle" || (deep.status === "failure" && deep.retryable));
  return (
    <div
      className={`flex max-w-full ${
        message.sender === "user" ? "justify-end" : "justify-start"
      }`}
      role={message.error ? "alert" : undefined}
    >
      <div
        className={`w-fit rounded-lg p-3 text-foreground ${
          message.sender === "user"
            ? "max-w-xl bg-muted"
            : message.error
              ? "max-w-3xl border border-border bg-muted/50"
              : "max-w-3xl"
        }`}
      >
        {message.sender === "ai" ? (
          <div className="space-y-2 text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-1.5 [&_em]:italic [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
            <MarkdownAnswer
              text={message.text}
              citationUrls={message.citationUrls}
            />
            {message.retryable && (
              <button
                type="button"
                onClick={() => onRetry(message.id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground/75 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Try again
              </button>
            )}
            {canResearch && (
              <button
                type="button"
                onClick={() => onResearch(message.id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground/75 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Telescope className="h-3.5 w-3.5" />
                {deep?.status === "failure" ? "Retry research" : "Research deeper"}
              </button>
            )}
            {deep?.status === "pending" && (
              <div
                className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {deep.progress}…
              </div>
            )}
            {deep?.status === "success" && deep.text && (
              <div className="mt-2 space-y-2 border-t border-border pt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Deeper research
                </div>
                <MarkdownAnswer
                  text={deep.text}
                  citationUrls={deep.citationUrls}
                />
              </div>
            )}
            {deep?.status === "failure" && deep.text && (
              <div className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
                {deep.text}
              </div>
            )}
          </div>
        ) : (
          message.text
        )}
      </div>
    </div>
  );
}
