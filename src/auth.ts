import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

/**
 * Full Auth.js (NextAuth v5) instance. Uses JWT sessions, so no database
 * adapter is required — ideal for serverless on Vercel.
 *
 * Exposes:
 *  - handlers: GET/POST route handlers for /api/auth/[...nextauth]
 *  - auth:     read the session in server components / actions / middleware
 *  - signIn / signOut: server-action helpers used by the UI
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
