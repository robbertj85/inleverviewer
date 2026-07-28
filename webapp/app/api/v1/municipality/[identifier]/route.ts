import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

import { checkRateLimit, clientIp } from '@/lib/rateLimit';

/**
 * GET /api/v1/municipality/{identifier}
 *
 * Returns a municipality's inleverpunten as GeoJSON. The identifier is
 * forgiving on purpose — callers may hold a name, a slug or a CBS code, and
 * Dutch municipality names have enough spelling variants that an exact match
 * would fail far too often.
 */

const RATE_LIMIT = 30;
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

/** Common alternative spellings that do not survive naive normalisation. */
const ALIASES: Record<string, string> = {
  'den haag': 's-gravenhage',
  'the hague': 's-gravenhage',
  haag: 's-gravenhage',
  'den bosch': 's-hertogenbosch',
  denbosch: 's-hertogenbosch',
  'den-bosch': 's-hertogenbosch',
  bosch: 's-hertogenbosch',
  'bergen nh': 'bergen-nh',
  'bergen l': 'bergen-l',
  'nuenen, gerwen en nederwetten': 'nuenen-ca',
  'nuenen gerwen en nederwetten': 'nuenen-ca',
};

function normalise(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/** Strip everything but letters and digits, for a last-resort fuzzy compare. */
function squash(value: string): string {
  return normalise(value).replace(/[^a-z0-9]/g, '');
}

function findMunicipality(
  municipalities: Municipality[],
  identifier: string
): Municipality | null {
  const needle = normalise(identifier);

  const bySlug = municipalities.find((m) => m.slug === needle);
  if (bySlug) return bySlug;

  const alias = ALIASES[needle];
  if (alias) {
    const byAlias = municipalities.find((m) => m.slug === alias);
    if (byAlias) return byAlias;
  }

  const byCode = municipalities.find(
    (m) => m.code && m.code.trim().toLowerCase() === needle
  );
  if (byCode) return byCode;

  const byName = municipalities.find((m) => normalise(m.name) === needle);
  if (byName) return byName;

  const squashed = squash(identifier);
  const byFuzzy = municipalities.find(
    (m) => squash(m.name) === squashed || squash(m.slug) === squashed
  );
  if (byFuzzy) return byFuzzy;

  return null;
}

function jsonError(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ identifier: string }> }
) {
  const limit = checkRateLimit(`api-v1:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS);

  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        message: `Maximum ${RATE_LIMIT} requests per hour`,
      },
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          'Retry-After': String(limit.retryAfterSeconds),
          'X-RateLimit-Limit': String(limit.limit),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  const { identifier } = await context.params;

  if (!identifier) {
    return jsonError(400, {
      error: 'Missing identifier',
      message: 'Provide a municipality name, slug or CBS code.',
    });
  }

  const indexPath = path.join(process.cwd(), 'public', 'municipalities.json');
  if (!fs.existsSync(indexPath)) {
    return jsonError(500, { error: 'Municipality index not available' });
  }

  const municipalities: Municipality[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const municipality = findMunicipality(municipalities, identifier);

  if (!municipality) {
    return jsonError(404, {
      error: 'Municipality not found',
      message: `No municipality matched "${identifier}".`,
      hint: 'Try a name ("Zwolle"), a slug ("zwolle") or a CBS code ("GM0193").',
    });
  }

  const filePath = path.join(
    process.cwd(),
    'public',
    'data',
    `${municipality.slug}.geojson`
  );

  if (!fs.existsSync(filePath)) {
    return jsonError(404, {
      error: 'Data not found',
      message: `No data file for "${municipality.name}".`,
    });
  }

  return new NextResponse(fs.readFileSync(filePath, 'utf-8'), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/geo+json',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'X-RateLimit-Limit': String(limit.limit),
      'X-RateLimit-Remaining': String(limit.remaining),
      'X-Municipality-Name': encodeURIComponent(municipality.name),
      'X-Municipality-Slug': municipality.slug,
      'X-Municipality-Code': municipality.code ?? 'N/A',
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}
