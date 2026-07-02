import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import { enforceAuth, hasApple, hasGoogle } from "@/lib/config";

// Edge-safe: keep this file free of Node-only imports (shared with middleware).
const providers = [];
if (hasGoogle) {
  providers.push(
    Google({
      // Force account chooser + refresh token semantics; helps avoid silent
      // re-auth surprises during a showcase demo.
      authorization: { params: { prompt: "select_account" } },
    })
  );
}
if (hasApple) {
  providers.push(Apple);
}

const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export const authConfig = {
  providers,
  session: { strategy: "jwt" },
  // Route OAuth failures (state-cookie replays from back/forward navigation,
  // config errors, denied consent) back to the styled login page instead of
  // NextAuth's raw built-in error screen.
  pages: { signIn: "/login", error: "/login" },
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      if (!enforceAuth) return true;

      const { pathname } = request.nextUrl;
      const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
      if (isPublic) return true;

      return Boolean(auth?.user);
    },
    jwt({ token, profile }) {
      if (profile?.email && !token.email) token.email = profile.email;
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
