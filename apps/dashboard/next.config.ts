import type { NextConfig } from 'next';
import path from 'node:path';

/**
 * The dashboard is a client of the public API only. The browser talks to the dashboard's own
 * origin, and /v1/* is forwarded to the API (same-origin proxy), so the API's HttpOnly session
 * cookie belongs to this origin and the API's CORS stays closed to cookies. Rewrites are computed at
 * build time: set OCTO_API_URL before `next build`.
 */
const apiUrl = (process.env.OCTO_API_URL ?? 'http://127.0.0.1:3300').replace(/\/+$/, '');
const repoRoot = path.resolve(import.meta.dirname, '../..');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The microphone is used by "Talk to assistant" on this origin only
  { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The web SDK is imported from packages/sdk/src, outside this app
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
