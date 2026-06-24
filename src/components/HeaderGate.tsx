"use client";

import { usePathname } from "next/navigation";

// The login page is a full-bleed editorial "front page" with its own masthead,
// so the global app chrome would only compete with it. Hide the sticky header
// on /login and let that route own the full viewport.
export function HeaderGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return <>{children}</>;
}
