import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

import { checkRateLimit, clientIp } from '@/lib/rateLimit';

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const CSV_COLUMNS = [
  'locatieNaam',
  'straatNaam',
  'straatNr',
  'postcode',
  'plaats',
  'latitude',
  'longitude',
  'merk',
  'puntType',
  'materialen',
  'uitbetaling',
  'vrijToegankelijk',
  'gemeenteBeperking',
  'bronId',
] as const;

interface GeoJsonFeature {
  properties: Record<string, unknown>;
  geometry: { coordinates: [number, number] };
}

/** Escape one CSV cell, quoting only when necessary. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = Array.isArray(value) ? value.join('|') : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(geojson: { features: GeoJsonFeature[] }): string {
  const points = geojson.features.filter((f) => f.properties?.type === 'inleverpunt');

  if (points.length === 0) return 'Geen inleverpunten gevonden';

  const rows = points.map((feature) => {
    const props = feature.properties;
    return CSV_COLUMNS.map((column) => {
      if (column === 'latitude') return csvCell(props.latitude ?? feature.geometry.coordinates[1]);
      if (column === 'longitude') return csvCell(props.longitude ?? feature.geometry.coordinates[0]);
      return csvCell(props[column]);
    }).join(',');
  });

  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

export async function GET(request: NextRequest) {
  const limit = checkRateLimit(`download:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS);

  if (!limit.allowed) {
    return new NextResponse(
      `Te veel downloads. Maximaal ${RATE_LIMIT} per uur.`,
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  const slug = request.nextUrl.searchParams.get('slug');
  const format = request.nextUrl.searchParams.get('format');

  if (!slug || !format) {
    return new NextResponse('Ontbrekende parameter: slug of format', { status: 400 });
  }

  if (format !== 'json' && format !== 'csv') {
    return new NextResponse('Ongeldig formaat. Gebruik json of csv.', { status: 400 });
  }

  // Reject anything that is not a plain slug before it reaches the filesystem.
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return new NextResponse('Ongeldige gemeente-slug', { status: 400 });
  }

  const filePath = path.join(process.cwd(), 'public', 'data', `${slug}.geojson`);

  if (!fs.existsSync(filePath)) {
    return new NextResponse('Gemeente niet gevonden', { status: 404 });
  }

  const contents = fs.readFileSync(filePath, 'utf-8');

  if (format === 'json') {
    return new NextResponse(contents, {
      headers: {
        'Content-Type': 'application/geo+json',
        'Content-Disposition': `attachment; filename="inleverpunten-${slug}.geojson"`,
        'X-RateLimit-Limit': String(limit.limit),
        'X-RateLimit-Remaining': String(limit.remaining),
      },
    });
  }

  return new NextResponse(toCsv(JSON.parse(contents)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inleverpunten-${slug}.csv"`,
      'X-RateLimit-Limit': String(limit.limit),
      'X-RateLimit-Remaining': String(limit.remaining),
    },
  });
}
