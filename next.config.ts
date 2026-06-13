import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy.
// NOTE: 'unsafe-inline'/'unsafe-eval' are required by Next.js' runtime, Recharts
// and Framer Motion without a nonce setup. This is a pragmatic baseline that
// won't break the app; tightening to a nonce-based CSP is a follow-up task.
//
// connect-src: the browser only ever talks to our own origin (all third-party
// API keys live server-side, OAuth happens via top-level navigation). So we lock
// it to 'self' in production, and only relax it in dev for the HMR websocket.
const connectSrc = isProd
  ? "connect-src 'self'"
  : "connect-src 'self' ws: wss: http://localhost:* https:";

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  connectSrc,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  // Belt-and-suspenders alongside the metadata `robots` tag in layout.tsx —
  // also covers non-HTML responses. Drop this once the app should be indexable.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
