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
        className="h-11 gap-2 rounded-xl px-6 font-semibold transition-all hover:-translate-y-0.5"
      >
        <RotateCcw className="size-4" />
        Try again
      </Button>
      <Button
        size="lg"
        variant="outline"
        asChild
        className="h-11 gap-2 rounded-xl px-6 font-semibold transition-all hover:-translate-y-0.5"
      >
        <Link href="/">
          <Home className="size-4" />
          Go home
        </Link>
      </Button>
    </ErrorScene>
  )
}
