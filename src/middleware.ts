import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { authConfigured } from "@/lib/config";

const { auth } = NextAuth(authConfig);

// Skip NextAuth in demo mode: without a secret it logs a MissingSecret error
// on every request, flooding logs. A passthrough is behaviourally identical.
export const middleware = authConfigured ? auth : () => NextResponse.next();

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
