import { redirect } from "next/navigation"
import { LoginForm } from "@/components/login-form"
import { auth } from "@/auth"
import { authConfigured } from "@/lib/config"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  // If already signed in, there's nothing to do here.
  if (authConfigured) {
    const session = await auth()
    if (session?.user) redirect("/")
  }

  const { error } = await searchParams

  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-center text-sm text-red-700">
            Sign-in failed. Please try again.
          </div>
        )}
        <LoginForm />
      </div>
    </div>
  )
}
