import Link from "next/link"
import { Home } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ErrorScene } from "@/components/error/ErrorScene"

export default function NotFound() {
  return (
    <ErrorScene
      code="404"
      title="Page not found"
      description="This page doesn't exist or may have been moved. Check the URL, or head back to the dashboard."
    >
      <Button
        size="lg"
        asChild
        variant="outline"
        className="h-11 gap-2.5 rounded-full border-foreground/30 bg-background/70 px-8 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-foreground hover:bg-foreground hover:text-background dark:bg-background/85"
      >
        <Link href="/">
          <Home className="size-3.5" />
          Go home
        </Link>
      </Button>
    </ErrorScene>
  )
}
