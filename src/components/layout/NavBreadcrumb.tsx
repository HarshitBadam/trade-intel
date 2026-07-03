"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavBreadcrumb() {
  const pathname = usePathname();
  const match = pathname?.match(/^\/details\/([^/]+)/);
  if (!match) return null;

  const ticker = decodeURIComponent(match[1])
    .toUpperCase()
    .replace(/[^A-Z.]/g, "")
    .slice(0, 6);
  if (!ticker) return null;

  return (
    <nav aria-label="Breadcrumb" className="animate-in fade-in slide-in-from-left-1 duration-300">
      <ol className="flex items-center gap-2.5 list-none m-0 p-0 select-none">
        <li className="flex items-center gap-2.5">
          <Separator />
          <Link
            href="/"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring"
          >
            Dashboard
          </Link>
        </li>
        <li className="flex items-center gap-2.5">
          <Separator />
          <span
            aria-current="page"
            className="font-mono text-xs font-semibold tracking-[0.2em] text-foreground/80"
          >
            {ticker}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-muted-foreground/40 font-light">
      /
    </span>
  );
}
