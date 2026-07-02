"use client"

import Link from "next/link"
import { Home, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ErrorScene } from "@/components/error/ErrorScene"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <ErrorScene
      code="500"
      title="Something went wrong"
      description="An unexpected error occurred on our end. It's usually temporary — trying again almost always fixes it."
      footnote={error.digest ? `Ref: ${error.digest}` : undefined}
    >
      <Button
        size="lg"
        onClick={reset}
        variant="outline"
        className="h-11 gap-2.5 rounded-full border-foreground/30 bg-background/70 px-8 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-foreground hover:bg-foreground hover:text-background dark:bg-background/85"
      >
        <RotateCcw className="size-3.5" />
        Try again
      </Button>
      <Button
        size="lg"
        variant="outline"
        asChild
        className="h-11 gap-2.5 rounded-full border-foreground/15 bg-transparent px-8 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-foreground/40 hover:text-foreground"
      >
        <Link href="/">
          <Home className="size-3.5" />
          Go home
        </Link>
      </Button>
    </ErrorScene>
  )
}
