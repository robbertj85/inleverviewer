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
        // The embed route is meant to be framed by other sites.
        source: '/embed',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
        ],
      },
    ];
  },
};

export default nextConfig;
