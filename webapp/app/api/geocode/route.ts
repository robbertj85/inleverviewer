import { NextRequest, NextResponse } from 'next/server';

import { checkRateLimit, clientIp } from '@/lib/rateLimit';

/**
 * Proxy for Nominatim address search.
 *
 * Going through our own route means we can set a proper User-Agent (Nominatim
 * requires one), constrain results to the Netherlands, and rate limit per
 * client so the browser cannot hammer a free community service.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')?.trim();

  if (!query || query.length < 3) {
    return NextResponse.json([], { status: 200 });
  }

  const limit = checkRateLimit(`geocode:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Te veel zoekopdrachten. Probeer het zo opnieuw.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'nl');
  url.searchParams.set('limit', '6');
  url.searchParams.set('accept-language', 'nl');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Inleverpuntenviewer/1.0 (https://github.com/robbertj85/inleverviewer)',
        'Accept-Language': 'nl',
      },
      // Identical searches are common; a short cache spares Nominatim.
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Geocoding-service niet beschikbaar' },
        { status: 502 }
      );
    }

    return NextResponse.json(await response.json(), {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return NextResponse.json({ error: 'Geocoding mislukt' }, { status: 502 });
  }
}
