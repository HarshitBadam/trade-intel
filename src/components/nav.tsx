import Link from "next/link"
import { auth } from "@/auth"
import { authConfigured } from "@/lib/config"
import { signOutAction } from "@/lib/auth-actions"

export async function MainNav() {
  const session = authConfigured ? await auth() : null
  const user = session?.user

  return (
    <div className="flex w-full px-4 shadow-md">
      <div className="flex w-full max-w-8xl mx-auto justify-between items-center">
        <div className="flex items-center">
          <Link href="/" className="flex items-center">
            <span className="inline-block font-extrabold p-4">TRADEINTEL</span>
          </Link>
        </div>

        <div className="flex items-center gap-6 p-4">
          <Link
            href="/"
            className="flex items-center text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Stocks
          </Link>

          {user ? (
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user.email ?? user.name}
              </span>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  Sign out
                </button>
              </form>
            </div>
          ) : (
            <Link
              href="/login"
              className="flex items-center text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Login
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
