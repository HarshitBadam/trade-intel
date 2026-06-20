import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { MainNav } from "@/components/nav";
import { ChartProvider } from "@/context/ChartContext";

const inter = Inter({ subsets: ["latin"] });

// LLM round-trips can exceed Vercel's default 10s timeout.
export const maxDuration = 60;

export const metadata: Metadata = {
  title: {
    default: "TradeIntel Stock Sentiment Dashboard",
    template: "%s | TradeIntel",
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
        {/* Sync theme before first paint to avoid FOUC. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t!=='light'&&m)){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`,
          }}
        />
        <div className="relative flex min-h-screen flex-col">
          <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/70 backdrop-blur-xl backdrop-saturate-150">
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
