import { NextRequest, NextResponse } from 'next/server';

import { checkRateLimit, clientIp } from '@/lib/rateLimit';

/**
 * Proxy for the PDOK Locatieserver.
 *
 * PDOK is the authoritative Dutch address service, which matters more than it
 * sounds: its `gemeentenaam` is the official CBS name, and our municipality
 * index is built from the same register (PDOK bestuurlijke gebieden). So a
 * result can be matched to a municipality by exact string equality instead of
 * the fuzzy contains-matching a general-purpose geocoder forces on you —
 * "Bergen (NH)", "Hengelo (O)" and "'s-Gravenhage" all line up on both sides.
 *
 * Two steps, because that is how Locatieserver is built:
 *   ?q=...   suggest — fast autocomplete, returns ids and display names
 *   ?id=...  lookup  — full record for one id, including coordinates
 *
 * Suggest deliberately does not return coordinates, so the client resolves the
 * chosen suggestion rather than every keystroke.
 */

const SUGGEST_URL = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest';
const LOOKUP_URL = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup';

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

// Everything a user might reasonably type into an address box. Excluding the
// noisier types (perceel, hectometerpaal) keeps the dropdown readable.
const SUGGEST_TYPES = 'type:(adres OR postcode OR weg OR woonplaats OR gemeente)';

interface SuggestDoc {
  id: string;
  weergavenaam: string;
  type: string;
  score: number;
}

interface LookupDoc {
  id: string;
  weergavenaam: string;
  gemeentenaam?: string;
  straatnaam?: string;
  huisnummer?: string;
  postcode?: string;
  woonplaatsnaam?: string;
  centroide_ll?: string;
}

/** Parse Locatieserver's "POINT(lon lat)" into a coordinate pair. */
function parseCentroid(wkt: string | undefined) {
  const match = /POINT\(([-\d.]+)\s+([-\d.]+)\)/.exec(wkt ?? '');
  if (!match) return null;
  return { longitude: parseFloat(match[1]), latitude: parseFloat(match[2]) };
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')?.trim();
  const id = request.nextUrl.searchParams.get('id')?.trim();

  if (!query && !id) {
    return NextResponse.json(
      { error: 'Geef een zoekterm (q) of een id op.' },
      { status: 400 }
    );
  }

  const limit = checkRateLimit(`geocode:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Te veel zoekopdrachten. Probeer het zo opnieuw.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  try {
    if (id) {
      const url = new URL(LOOKUP_URL);
      url.searchParams.set('id', id);
      url.searchParams.set('fl', '*');

      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 86400 },
      });
      if (!response.ok) {
        return NextResponse.json(
          { error: 'Adresservice niet beschikbaar' },
          { status: 502 }
        );
      }

      const doc: LookupDoc | undefined = (await response.json())?.response?.docs?.[0];
      if (!doc) {
        return NextResponse.json({ error: 'Adres niet gevonden' }, { status: 404 });
      }

      return NextResponse.json(
        {
          id: doc.id,
          displayName: doc.weergavenaam,
          municipality: doc.gemeentenaam ?? null,
          street: doc.straatnaam ?? null,
          houseNumber: doc.huisnummer ?? null,
          postalCode: doc.postcode ?? null,
          city: doc.woonplaatsnaam ?? null,
          coordinates: parseCentroid(doc.centroide_ll),
        },
        { headers: { 'Cache-Control': 'public, max-age=86400' } }
      );
    }

    if (query!.length < 3) {
      return NextResponse.json({ results: [] });
    }

    const url = new URL(SUGGEST_URL);
    url.searchParams.set('q', query!);
    url.searchParams.set('fq', SUGGEST_TYPES);
    url.searchParams.set('rows', '8');

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      // Identical prefixes are typed constantly; a short cache spares PDOK.
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      return NextResponse.json({ error: 'Adresservice niet beschikbaar' }, { status: 502 });
    }

    const docs: SuggestDoc[] = (await response.json())?.response?.docs ?? [];

    return NextResponse.json(
      {
        results: docs.map((doc) => ({
          id: doc.id,
          displayName: doc.weergavenaam,
          type: doc.type,
        })),
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=3600',
          'X-RateLimit-Limit': String(limit.limit),
          'X-RateLimit-Remaining': String(limit.remaining),
        },
      }
    );
  } catch {
    return NextResponse.json({ error: 'Zoeken mislukt' }, { status: 502 });
  }
}
