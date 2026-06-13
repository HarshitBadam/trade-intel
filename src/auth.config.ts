import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import { enforceAuth, hasApple, hasGoogle } from "@/lib/config";

/**
 * Edge-safe Auth.js configuration. Shared between the middleware (edge runtime)
 * and the full Node instance in auth.ts. Keep this free of Node-only imports.
 *
 * Providers are added only when their credentials exist, so the app builds and
 * runs in demo mode with zero auth configuration.
 */

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

// Routes that never require authentication.
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export const authConfig = {
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: true,
  callbacks: {
    /**
     * Gatekeeper used by the middleware. Returning false / a redirect blocks
     * the request. When auth isn't configured we stay fully open (demo mode).
     */
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
