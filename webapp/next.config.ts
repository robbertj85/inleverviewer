import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /*
   * The API and download routes read GeoJSON straight off disk at request
   * time. Next's dependency tracer cannot see those reads (the filename is
   * built from a request parameter), so the data has to be declared here or
   * the routes 404 on Vercel while working fine locally.
   *
   * Scoped per route so the ~32 MB of GeoJSON only lands in the two functions
   * that actually need it.
   */
  outputFileTracingIncludes: {
    '/api/download': ['./public/data/**/*.geojson'],
    '/api/v1/municipality/[identifier]': [
      './public/data/**/*.geojson',
      './public/municipalities.json',
    ],
    '/api/v1/municipalities': [
      './public/municipalities.json',
      './public/data/summary.json',
    ],
  },

  async headers() {
    /*
     * Every origin the app actually talks to, and nothing else:
     *  - cdn.redoc.ly    the API docs bundle (script only, /api/v1/docs)
     *  - cartocdn.com    basemap tiles; markers are divIcons, so no icon CDN
     *  - va.vercel-scripts.com  Vercel Analytics
     * The OpenAPI spec and the fonts are same-origin (next/font self-hosts).
     *
     * 'unsafe-inline' and 'unsafe-eval' are Next's and Redoc's requirements,
     * not ours. Dropping them means moving to a nonce-based policy.
     */
    const scriptSrc =
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.redoc.ly https://va.vercel-scripts.com";

    const sharedCsp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.basemaps.cartocdn.com",
      "font-src 'self' data:",
      "connect-src 'self' https://va.vercel-scripts.com",
      // Redoc runs its search indexer in a blob worker.
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
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
              'frame-ancestors *',
            ].join('; '),
          },
        ],
      },
      {
        source: '/((?!embed).*)',
        headers: [
          ...securityHeaders,
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: [...sharedCsp, scriptSrc, "frame-ancestors 'none'"].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
