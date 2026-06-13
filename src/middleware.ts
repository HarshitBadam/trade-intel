import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { authConfigured } from "@/lib/config";

const { auth } = NextAuth(authConfig);

// In demo mode (auth not configured) we skip NextAuth entirely. Invoking it per
// request logs a `MissingSecret` error on every hit — NextAuth v5 requires a
// secret even though our `authorized` callback would just `return true` — which
// floods Vercel logs and can mask real errors. A passthrough is behaviourally
// identical in that mode, minus the noise. When auth IS configured we delegate
// to NextAuth so the `authorized` callback gates protected routes.
export const middleware = authConfigured ? auth : () => NextResponse.next();

export const config = {
  // Run on all routes except Next internals and static asset files. The
  // `authorized` callback in auth.config.ts decides what actually needs a login.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
