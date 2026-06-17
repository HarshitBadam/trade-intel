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
