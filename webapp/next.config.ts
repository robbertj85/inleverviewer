import type { NextConfig } from 'next';

// Served under a path prefix behind the reverse proxy (see deploy/), e.g.
// NEXT_PUBLIC_BASE_PATH=/inleverpuntenviewer. Empty for local dev.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

// Optional self-hosted Umami analytics: allow its origin in the CSP.
const UMAMI_ORIGIN = process.env.NEXT_PUBLIC_UMAMI_SRC
  ? new URL(process.env.NEXT_PUBLIC_UMAMI_SRC).origin
  : '';

const nextConfig: NextConfig = {
  basePath,
  // Self-contained server bundle for the Docker image (deploy/Dockerfile.web).
  // The data is not in it: server code reads it from INLEVER_PUBLIC_DIR (see
  // lib/dataPaths.ts) and nginx serves /data/* straight off the volume.
  output: 'standalone',

  async headers() {
    /*
     * Every origin the app actually talks to, and nothing else:
     *  - cdn.redoc.ly    the API docs bundle (script only, /api/v1/docs)
     *  - basemaps.cartocdn.com and its tiles. subdomain: the CARTO vector
     *                    styles, fetched by MapLibre (connect-src), whose worker
     *                    is served same-origin (worker-src 'self')
     *  - tile.openstreetmap.org, service.pdok.nl
     *                    raster basemap tiles (img-src);
     *                    markers are divIcons, so no icon CDN
     *  - the Umami origin, only when NEXT_PUBLIC_UMAMI_SRC is set
     * The OpenAPI spec and the fonts are same-origin (next/font self-hosts).
     *
     * 'unsafe-inline' and 'unsafe-eval' are Next's and Redoc's requirements,
     * not ours. Dropping them means moving to a nonce-based policy.
     */
    const scriptSrc = `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.redoc.ly ${UMAMI_ORIGIN}`;

    const sharedCsp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://tile.openstreetmap.org https://service.pdok.nl",
      "font-src 'self' data:",
      `connect-src 'self' https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com ${UMAMI_ORIGIN}`,
      // Redoc runs its search indexer in a blob worker; MapLibre's is same-origin.
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ];

    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];

    const pageHeaders = [
      ...securityHeaders,
      { key: 'X-Frame-Options', value: 'DENY' },
      {
        key: 'Content-Security-Policy',
        value: [...sharedCsp, scriptSrc, "frame-ancestors 'none'"].join('; '),
      },
    ];

    return [
      {
        // The data is regenerated weekly, so a long browser cache with
        // revalidation is safe and keeps repeat visits instant.
        source: '/data/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=604800' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
      {
        source: '/municipalities.json',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=604800' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
      {
        // The embed route is meant to be framed by other sites, so it opts out
        // of the frame-ancestors restriction below. It carries no Redoc, so it
        // does not need that script origin either.
        //
        // Note there is deliberately no X-Frame-Options here: the header has no
        // "allow any origin" value (ALLOWALL is not in the spec and is ignored),
        // and sending DENY/SAMEORIGIN would block the embed in browsers that
        // prefer it over CSP. frame-ancestors is the mechanism that works.
        source: '/embed',
        headers: [
          ...securityHeaders,
          {
            key: 'Content-Security-Policy',
            value: [
              ...sharedCsp,
              `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${UMAMI_ORIGIN}`,
              'frame-ancestors *',
            ].join('; '),
          },
        ],
      },
      { source: '/((?!embed).*)', headers: pageHeaders },
      // Under a basePath the pattern above becomes "/inleverpuntenviewer/(...)"
      // and no longer matches the bare root, which would then go out with no
      // CSP or frame protection at all.
      ...(basePath ? [{ source: '/', headers: pageHeaders }] : []),
    ];
  },
};

export default nextConfig;
