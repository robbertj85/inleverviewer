import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

import { checkRateLimit, clientIp } from '@/lib/rateLimit';

/**
 * GET /api/v1/municipalities
 *
 * Lists every municipality with its slug, CBS code, province and current
 * point count — the index you need before calling the per-municipality
 * endpoint.
 */

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface Municipality {
  name: string;
  slug: string;
  province: string;
  population: number;
  code: string | null;
}

interface SummaryResult {
  slug: string;
  count: number;
}

export async function GET(request: NextRequest) {
  const limit = checkRateLimit(
    `api-v1-list:${clientIp(request)}`,
    RATE_LIMIT,
    RATE_WINDOW_MS
  );

  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', message: `Maximum ${RATE_LIMIT} requests per hour` },
      {
        status: 429,
        headers: { ...CORS_HEADERS, 'Retry-After': String(limit.retryAfterSeconds) },
      }
    );
  }

  const publicDir = path.join(process.cwd(), 'public');
  const indexPath = path.join(publicDir, 'municipalities.json');

  if (!fs.existsSync(indexPath)) {
    return NextResponse.json(
      { error: 'Municipality index not available' },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  const municipalities: Municipality[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

  // Point counts come from the batch summary; missing summary is not fatal.
  const counts = new Map<string, number>();
  const summaryPath = path.join(publicDir, 'data', 'summary.json');
  if (fs.existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      for (const result of (summary.results ?? []) as SummaryResult[]) {
        counts.set(result.slug, result.count);
      }
    } catch {
      // Fall through with an empty count map.
    }
  }

  const payload = municipalities.map((municipality) => ({
    ...municipality,
    total_points: counts.get(municipality.slug) ?? null,
    url: `/api/v1/municipality/${municipality.slug}`,
  }));

  return NextResponse.json(
    { total: payload.length, municipalities: payload },
    {
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-RateLimit-Limit': String(limit.limit),
        'X-RateLimit-Remaining': String(limit.remaining),
      },
    }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}
