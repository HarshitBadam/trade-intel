import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { MainNav } from "@/components/nav";
import { ChartProvider } from "@/context/ChartContext";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Your Website",
  description: "A modern website built with Next.js, React, and shadcn/ui",
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
          <footer>
            <div className="px-4 sm:px-6 lg:px-8 mx-auto max-w-9xl flex h-14 items-center">
              <p className="text-sm text-muted-foreground">
                Built with Next.js and shadcn/ui
              </p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
