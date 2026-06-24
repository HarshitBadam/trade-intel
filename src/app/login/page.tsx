import { redirect } from "next/navigation"
import { Gauge, Quote, Sparkles } from "lucide-react"
import { LoginForm } from "@/components/login-form"
import { ThemeToggle } from "@/components/ThemeToggle"
import { InteractiveGuilloche } from "@/components/login/InteractiveGuilloche"
import { BrandMarquee } from "@/components/login/BrandMarquee"
import { auth } from "@/auth"
import { authConfigured } from "@/lib/config"

// Product capabilities — describes what TradeIntel does, never any specific
// company, price or quote. Safe to show before the auth/T&C wall.
const CAPABILITIES = [
  {
    icon: Sparkles,
    title: "AI Summaries",
    body: "Thousands of headlines, distilled to the point.",
  },
  {
    icon: Gauge,
    title: "Sentiment Signals",
    body: "Bullish or bearish — scored, and explained.",
  },
  {
    icon: Quote,
    title: "Cited Sources",
    body: "Every claim links back to where it came from.",
  },
]

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  if (authConfigured) {
    const session = await auth()
    if (session?.user) redirect("/")
  }

  const { error } = await searchParams
  const today = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date())

  return (
    <div className="login-newsprint relative flex min-h-svh flex-col overflow-x-hidden bg-[#f7f5f0] md:h-svh md:overflow-hidden dark:bg-transparent">
      {/* Warm paper glow in light; the global aurora shows through in dark. */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(110%_80%_at_50%_0%,rgba(0,0,0,0.045),transparent_60%)] dark:hidden" />

      {/* Tactile grain: paper tooth in light, film/CRT grain in dark. */}
      <div className="login-grain" aria-hidden="true" />

      <div className="relative z-10 mx-auto flex w-full max-w-[1280px] min-h-0 flex-1 flex-col px-6 sm:px-8 lg:px-12">
        {/* ── Masthead ──────────────────────────────────────────────────────── */}
        <header className="pt-4 sm:pt-5">
          <div className="flex items-center justify-between gap-4 border-b border-foreground/15 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-muted-foreground sm:text-[11px] dark:border-white/15">
            <span>Market Intelligence</span>
            <div className="flex items-center gap-3 sm:gap-4">
              <span suppressHydrationWarning className="hidden tabular-nums sm:inline">
                {today}
              </span>
              <ThemeToggle />
            </div>
          </div>

          <div className="pt-2.5 text-center sm:pt-3">
            <h1 className="wordmark-enter siri-text font-display text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
              TradeIntel
            </h1>
            <p className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.3em] text-muted-foreground sm:text-[11px]">
              AI Stock Sentiment &amp; Market Intelligence
            </p>
          </div>

          {/* Broadsheet rule, capped with a centered diamond terminator. */}
          <div className="mt-2.5 flex items-center gap-3 sm:mt-3">
            <span className="h-0.5 flex-1 bg-foreground/70 dark:bg-white/40" />
            <span className="size-1.5 rotate-45 bg-foreground/70 dark:bg-white/50" />
            <span className="h-0.5 flex-1 bg-foreground/70 dark:bg-white/40" />
          </div>
          <div className="mt-[3px] border-t border-foreground/25 dark:border-white/15" />
        </header>

        {/* ── Hero: guilloché + editorial + sign-in ─────────────────────────── */}
        <section className="relative flex min-h-0 flex-1 items-center py-5 md:py-6">
          <InteractiveGuilloche className="login-guilloche pointer-events-none absolute left-1/2 top-1/2 z-0 aspect-square w-[min(680px,64vw)] -translate-x-1/2 -translate-y-1/2 sm:left-[56%]" />

          <div className="relative z-10 grid w-full grid-cols-1 items-center gap-8 md:grid-cols-[1.5fr_1fr] md:gap-10 lg:grid-cols-[1.55fr_1fr] lg:gap-14">
            <div className="max-w-[620px]">
              <p className="flex flex-wrap items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                <span>Est. MMXXVI</span>
                <span className="h-3 w-px bg-foreground/20" />
                <span>The Intelligence Desk</span>
              </p>

              <h2 className="font-display mt-3 text-4xl font-extrabold leading-[1.04] tracking-tight sm:text-5xl lg:mt-4 xl:text-[3.75rem]">
                What&rsquo;s moving every stock
                <span className="text-muted-foreground"> — </span>
                <em className="font-medium italic">and why.</em>
              </h2>

              <p className="font-display mt-4 max-w-[30em] text-base italic leading-relaxed text-foreground/70 sm:text-lg lg:text-xl">
                StockSage summarizes the news behind each move, scores the
                sentiment, and cites every source.
              </p>

              <dl className="mt-5 max-w-[31em] lg:mt-7">
                {CAPABILITIES.map(({ icon: Icon, title, body }) => (
                  <div
                    key={title}
                    className="flex items-start gap-3.5 border-t border-foreground/12 py-2.5 last:border-b lg:py-3 dark:border-white/10"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-foreground/12 text-foreground/80 dark:border-[rgba(139,123,255,0.3)] dark:bg-[rgba(139,123,255,0.12)] dark:text-[#cbb9ff]">
                      <Icon className="size-4" />
                    </span>
                    <div>
                      <dt className="text-sm font-bold tracking-tight">{title}</dt>
                      <dd className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                        {body}
                      </dd>
                    </div>
                  </div>
                ))}
              </dl>
            </div>

            <div className="flex w-full justify-center lg:justify-end">
              <div className="w-full max-w-[400px]">
                {error && (
                  <div className="mb-4 rounded-xl border border-red-300/70 bg-red-50 px-4 py-3 text-center text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                    Sign-in failed. Please try again.
                  </div>
                )}
                <LoginForm />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ── Foot: content-free brand marquee ──────────────────────────────── */}
      <BrandMarquee />
    </div>
  )
}
