interface TopNewsProps {
  title: string;
  newsTitle: string;
  newsContent: string;
  onClick?: () => void;
}

export default function TopNews({ title,newsTitle,newsContent, onClick }: TopNewsProps) {
  return (
    <div
      className="rounded-lg p-6 h-full bg-card shadow-md cursor-pointer"
      onClick={onClick}
    >
      {/* Title */}
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      
      <div className="space-y-6">
        
        <div className="pt-1">
          <h1 className="text-2xl font-bold font-serif line-clamp-3">{newsTitle}</h1>
          <p className="text-sm text-muted-foreground pt-4 line-clamp-5">{newsContent}</p>
        </div>
      </div>
    </div>
  );
}

// Loading placeholder shown until the real headline resolves, so the card never
// flashes fabricated news.
export function TopNewsSkeleton({ title = "Top News" }: { title?: string }) {
  return (
    <div className="rounded-lg p-6 h-full bg-card shadow-md animate-pulse">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <div className="space-y-3 pt-1">
        <div className="h-7 w-full rounded bg-muted" />
        <div className="h-7 w-3/4 rounded bg-muted" />
        <div className="pt-4 space-y-2">
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-2/3 rounded bg-muted" />
        </div>
      </div>
    </div>
  );
}
