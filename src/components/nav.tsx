import Link from "next/link"
import { auth } from "@/auth"
import { authConfigured } from "@/lib/config"
import { ThemeToggle } from "@/components/ThemeToggle"
import { UserMenu } from "@/components/UserMenu"

export async function MainNav() {
  const session = authConfigured ? await auth() : null
  const user = session?.user

  return (
    <div className="flex w-full">
      <div className="flex w-full max-w-[1600px] mx-auto items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex items-center font-extrabold tracking-tight transition-opacity hover:opacity-80"
        >
          TRADEINTEL
        </Link>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          {user ? (
            <UserMenu
              name={user.name}
              email={user.email}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
