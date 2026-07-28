import { test, expect } from '@playwright/test';

/**
 * Contract tests for the public API.
 *
 * These routes read GeoJSON off disk at request time, which is exactly the
 * thing that works locally and 404s in production when Next's file tracer
 * cannot see the read (see outputFileTracingIncludes in next.config.ts). A
 * failure here after a config change is the early warning for that.
 */

test.describe('GET /api/v1/municipalities', () => {
  test('geeft de index met aantallen terug', async ({ request }) => {
    const response = await request.get('/api/v1/municipalities');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.total).toBeGreaterThan(300);
    expect(body.municipalities.length).toBe(body.total);

    const zwolle = body.municipalities.find(
      (m: { slug: string }) => m.slug === 'zwolle'
    );
    expect(zwolle).toBeTruthy();
    expect(zwolle.province).toBe('Overijssel');
    expect(zwolle.code).toMatch(/^GM\d{4}$/);
    expect(zwolle.total_points).toBeGreaterThan(0);
    expect(zwolle.url).toBe('/api/v1/municipality/zwolle');
  });

  test('is CORS-open en cachebaar', async ({ request }) => {
    const response = await request.get('/api/v1/municipalities');
    expect(response.headers()['access-control-allow-origin']).toBe('*');
    expect(response.headers()['cache-control']).toContain('max-age');
  });
});

test.describe('GET /api/v1/municipality/[identifier]', () => {
  test('geeft geldige GeoJSON terug voor een slug', async ({ request }) => {
    const response = await request.get('/api/v1/municipality/zwolle');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.type).toBe('FeatureCollection');
    expect(Array.isArray(body.features)).toBe(true);
    expect(body.features.length).toBeGreaterThan(0);

    const [first] = body.features;
    expect(first.geometry.type).toBe('Point');
    const [lon, lat] = first.geometry.coordinates;
    // Roughly the Dutch bounding box — catches CRS mix-ups, which is the
    // failure mode that matters here (RD New metres in a WGS84 field).
    expect(lon).toBeGreaterThan(3);
    expect(lon).toBeLessThan(8);
    expect(lat).toBeGreaterThan(50);
    expect(lat).toBeLessThan(54);
  });

  test('geeft 404 voor een onbekende gemeente', async ({ request }) => {
    const response = await request.get('/api/v1/municipality/bestaatniet');
    expect(response.status()).toBe(404);
  });
});

test.describe('GET /api/download', () => {
  test('levert CSV met een kopregel', async ({ request }) => {
    const response = await request.get('/api/download?slug=zwolle&format=csv');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');

    const text = await response.text();
    const [header] = text.split('\n');
    expect(header).toContain('locatieNaam');
    expect(header).toContain('latitude');
  });

  test('levert GeoJSON', async ({ request }) => {
    const response = await request.get('/api/download?slug=zwolle&format=json');
    expect(response.status()).toBe(200);
    expect((await response.json()).type).toBe('FeatureCollection');
  });

  test('weigert een slug die geen slug is', async ({ request }) => {
    const response = await request.get('/api/download?slug=../../etc/passwd&format=json');
    expect(response.status()).toBe(400);
  });

  test('eist beide parameters', async ({ request }) => {
    expect((await request.get('/api/download?slug=zwolle')).status()).toBe(400);
    expect((await request.get('/api/download?format=csv')).status()).toBe(400);
  });
});

test.describe('GET /api/geocode', () => {
  test('suggest geeft PDOK-resultaten met een id', async ({ request }) => {
    const response = await request.get('/api/geocode?q=Binnenhof');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].id).toBeTruthy();
    expect(body.results[0].displayName).toBeTruthy();
  });

  test('lookup geeft coördinaten en de officiële gemeentenaam', async ({ request }) => {
    const suggest = await (await request.get('/api/geocode?q=Binnenhof%201')).json();
    const { id } = suggest.results[0];

    const response = await request.get(`/api/geocode?id=${encodeURIComponent(id)}`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.municipality).toBeTruthy();
    expect(body.coordinates.latitude).toBeGreaterThan(50);
    expect(body.coordinates.longitude).toBeGreaterThan(3);
  });

  test('korte zoektermen leveren niets op', async ({ request }) => {
    const body = await (await request.get('/api/geocode?q=ab')).json();
    expect(body.results).toEqual([]);
  });

  test('eist een parameter', async ({ request }) => {
    expect((await request.get('/api/geocode')).status()).toBe(400);
  });
});
