import { Button } from "@/components/ui/button"
import { authConfigured, hasApple, hasGoogle } from "@/lib/config"
import { signInWith } from "@/lib/auth-actions"
import { LegalModal } from "@/components/LegalModal"

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.36 12.78c.02 2.7 2.36 3.6 2.39 3.61-.02.06-.37 1.28-1.23 2.53-.74 1.09-1.5 2.17-2.71 2.19-1.18.02-1.56-.7-2.91-.7-1.35 0-1.78.68-2.9.72-1.16.05-2.05-1.17-2.8-2.25C4.66 16.97 3.5 12.9 5.08 10.16c.78-1.36 2.18-2.22 3.7-2.24 1.14-.02 2.22.77 2.91.77.7 0 2.01-.95 3.39-.81.58.02 2.2.23 3.25 1.76-.08.05-1.94 1.13-1.92 3.38M14.13 6.27c.61-.74 1.03-1.78.92-2.81-.88.04-1.96.59-2.6 1.33-.57.65-1.07 1.71-.94 2.71.99.08 1.99-.5 2.62-1.23"
      />
    </svg>
  )
}

// TradeIntel brand mark — the trending-up arrow from /icon.svg drawn in
// currentColor so it inherits the theme (dark ink on a light chip in light,
// light ink on a dark chip in dark) instead of a hard black block that read
// as out of place on the sign-in card.
function BrandLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      <path
        d="M6 21.5L13 14.5L17.5 19L26 10.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 10.5H26V15.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function LoginForm() {
  return (
    <div className="w-full rounded-2xl bg-white p-7 shadow-[0_4px_10px_-2px_rgba(15,23,42,0.08),0_20px_44px_-16px_rgba(15,23,42,0.24)] dark:border dark:border-white/10 dark:bg-white/[0.04] dark:shadow-xl dark:backdrop-blur-xl sm:p-8">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-white text-foreground ring-1 ring-inset ring-transparent shadow-[0_0_5px_rgba(0,0,0,0.14)] dark:bg-white/10 dark:text-foreground">
          <BrandLogo className="size-[18px]" />
        </span>
        <span className="text-sm font-extrabold tracking-tight">TRADEINTEL</span>
      </div>

      <div className="mt-7 space-y-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
        <p className="text-sm text-muted-foreground">
          Sign in to access your market dashboard.
        </p>
      </div>

      <div className="mt-7 flex flex-col gap-3">
        {authConfigured && hasGoogle && (
          <form
            action={signInWith.bind(null, "google")}
            className="rounded-xl"
          >
            <Button
              size="lg"
              type="submit"
              variant="outline"
              className="h-12 w-full justify-center gap-3 rounded-xl border-transparent bg-white text-[15px] font-semibold text-zinc-800 shadow-md transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-lg dark:border-transparent dark:bg-white/[0.08] dark:text-foreground dark:shadow-[0_1px_3px_rgba(0,0,0,0.3)] dark:hover:bg-white/[0.12]"
            >
              <GoogleIcon className="size-[18px]" />
              Continue with Google
            </Button>
          </form>
        )}

        {authConfigured && hasApple && (
          <form action={signInWith.bind(null, "apple")}>
            <Button
              size="lg"
              type="submit"
              className="h-12 w-full justify-center gap-2.5 rounded-xl bg-foreground text-[15px] font-medium text-background transition-all hover:-translate-y-px hover:bg-foreground/90"
            >
              <AppleIcon className="size-[18px]" />
              Continue with Apple
            </Button>
          </form>
        )}

        {!authConfigured && (
          <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3.5 text-center text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            Authentication isn&apos;t configured yet. The app is running in open{" "}
            <span className="font-medium">demo mode</span>. Add Google/Apple
            OAuth credentials and{" "}
            <code className="font-mono text-xs">AUTH_SECRET</code> to enable
            login.
          </div>
        )}
      </div>

      <div className="mt-7">
        <LegalModal />
      </div>
    </div>
  )
}
