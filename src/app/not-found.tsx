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
