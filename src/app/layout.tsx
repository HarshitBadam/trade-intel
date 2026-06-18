import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { MainNav } from "@/components/nav";
import { ChartProvider } from "@/context/ChartContext";

const inter = Inter({ subsets: ["latin"] });

// Allow the AI chat Server Action enough time to call Langflow → Gemini.
// Vercel functions default to ~10s; an LLM round-trip can exceed that. This
// route-segment config is inherited by all nested (client) pages.
export const maxDuration = 60;

export const metadata: Metadata = {
  title: {
    default: "TradeIntel — Stock Sentiment Dashboard",
    template: "%s · TradeIntel",
  },
  description:
    "Track stock performance and AI-powered news sentiment with TradeIntel.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen bg-background antialiased`}>
        <div className="relative flex min-h-screen flex-col">
          <header className="sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-bottom">
            <div className="flex h-14 w-full">
              <MainNav />
            </div>
          </header>
          <ChartProvider>
            <main className="flex-1">{children}</main>
          </ChartProvider>
        </div>
      </body>
    </html>
  );
}
