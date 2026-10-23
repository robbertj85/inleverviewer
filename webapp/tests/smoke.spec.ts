import { test, expect, type ConsoleMessage } from '@playwright/test';

/**
 * Page-level smoke tests.
 *
 * The console-error assertions are the point of this file: a Content-Security-
 * Policy that is too strict fails silently on the server and loudly in the
 * browser console ("Refused to load the script ..."), so this is the only
 * cheap way to know the policy in next.config.ts still matches what the app
 * actually loads.
 */

/**
 * Errors that say nothing about our code.
 *
 * A failed basemap tile (offline, or the CDN rate-limiting a CI runner) is
 * reported as a bare "Failed to load resource ... 404" with no URL in the
 * text, so it has to be matched loosely here — the precise assertions live in
 * the response and CSP checks below, which match on URL rather than on prose.
 */
const IGNORED_ERRORS = [
  /basemaps\.cartocdn\.com/i,
  /favicon/i,
  /Failed to load resource/i,
];

function collectErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED_ERRORS.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });

  page.on('pageerror', (error) => errors.push(error.message));

  return errors;
}

test.describe('Kaartpagina', () => {
  test('laadt zonder console-fouten en toont de kaart', async ({ page }) => {
    const errors = collectErrors(page);

    // Asserted on the URL rather than on the console text, so a genuine 404
    // still fails even though the generic console line is filtered out above.
    const failedRequests: string[] = [];
    page.on('response', (response) => {
      if (response.status() < 400) return;
      failedRequests.push(`${response.status()} ${response.url()}`);
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    await expect(page.locator('.leaflet-container')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    expect(errors, `Onverwachte console-fouten:\n${errors.join('\n')}`).toEqual([]);
    expect(
      failedRequests,
      `Requests die faalden:\n${failedRequests.join('\n')}`
    ).toEqual([]);
  });

  test('CSP staat de basemap-tegels toe', async ({ page }) => {
    const blocked: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      // Match the CSP wording specifically. A bare "Refused to execute" is not
      // enough: the browser uses the same opening for a MIME-type refusal.
      if (/Content Security Policy/i.test(text)) blocked.push(text);
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    expect(blocked, `CSP blokkeerde resources:\n${blocked.join('\n')}`).toEqual([]);
  });

  /**
   * One host per raster basemap, and every one of them has to be in `img-src`.
   *
   * Asserted on `naturalWidth` rather than on visibility: a tile the CSP
   * refused is still an <img> of the right size in the DOM, so it looks
   * perfectly visible to Playwright while showing nothing at all.
   */
  test('elke achtergrondkaart laadt tegels', async ({ page }) => {
    const blocked: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) blocked.push(message.text());
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    const basemaps = [
      { label: 'OpenStreetMap', host: 'tile.openstreetmap.org' },
      { label: 'BRT topografisch', host: 'service.pdok.nl' },
      { label: 'BRT donker', host: 'service.pdok.nl' },
    ];

    for (const basemap of basemaps) {
      // The list lives behind the floating button and closes on each pick.
      await page.getByRole('button', { name: /^Achtergrondkaart:/ }).click();
      await page.getByRole('radio', { name: basemap.label, exact: true }).click();

      const tile = page.locator(`.leaflet-tile-pane img[src*="${basemap.host}"]`).first();
      await expect
        .poll(
          async () =>
            tile.evaluate((img) => (img as HTMLImageElement).naturalWidth).catch(() => 0),
          { message: `Geen tegel geladen voor ${basemap.label}`, timeout: 20_000 }
        )
        .toBeGreaterThan(0);
    }

    expect(blocked, `CSP blokkeerde tegels:\n${blocked.join('\n')}`).toEqual([]);
  });

  /**
   * The CARTO styles are MapLibre vector maps, so there is no <img> to check.
   * Wait for an actual vector tile instead: CARTO's raster endpoint answers a
   * missing API key with a 200 PNG that says so, which an image-size check
   * happily accepts.
   */
  test('elke vectorkaart laadt vectortegels', async ({ page }) => {
    const blocked: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) blocked.push(message.text());
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    // Voyager last: it is the default, and re-picking the active style loads
    // nothing new. Each switch re-creates the GL map, so tiles are fetched.
    for (const label of ['Licht', 'Donker', 'Voyager']) {
      const tile = page.waitForResponse(
        (response) =>
          /basemaps\.cartocdn\.com\/.*\.mvt/.test(response.url()) &&
          response.status() === 200 &&
          /protobuf/.test(response.headers()['content-type'] ?? ''),
        { timeout: 20_000 }
      );
      await page.getByRole('button', { name: /^Achtergrondkaart:/ }).click();
      await page.getByRole('radio', { name: label, exact: true }).click();
      await tile;
      await expect(page.locator('.leaflet-tile-pane canvas.maplibregl-canvas')).toHaveCount(1);
      await expect(page.locator('.leaflet-control-attribution')).toContainText('CARTO');
    }

    expect(blocked, `CSP blokkeerde de vectorkaart:\n${blocked.join('\n')}`).toEqual([]);
  });
});

test.describe('Landelijk overzicht', () => {
  /**
   * ~34.000 points. They used to be React <CircleMarker>s with a <Popup> each,
   * which blocked the main thread for 6.5 s before the first dot; they are now
   * drawn on one canvas outside React with a single shared popup. The budget
   * is loose on purpose (CI is slow); the old path did not come close.
   */
  test('tekent alle punten snel en opent een popup', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __longest: number };
      w.__longest = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longest = Math.max(w.__longest, entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });

    await page.goto('/?gemeente=alle-gemeenten', { waitUntil: 'networkidle' });
    // FitBounds animates to the Netherlands; a dot found mid-flight moves away.
    await page.waitForTimeout(1500);

    // A dot centre: an opaque, non-white pixel whose neighbours are too (an
    // anti-aliased edge pixel can fall just outside Leaflet's hit area).
    const dot = await page.waitForFunction(
      () => {
        for (const canvas of document.querySelectorAll<HTMLCanvasElement>('.leaflet-overlay-pane canvas')) {
          const ctx = canvas.getContext('2d');
          if (!ctx || canvas.width === 0) continue;
          const box = canvas.getBoundingClientRect();
          const scale = canvas.width / box.width;
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let y = Math.floor(canvas.height * 0.3); y < canvas.height * 0.7; y += 3) {
            for (let x = Math.floor(canvas.width * 0.3); x < canvas.width * 0.7; x += 3) {
              const solid = [0, 2, -2].every((dx) =>
                [0, 2, -2].every((dy) => {
                  const i = ((y + dy) * canvas.width + (x + dx)) * 4;
                  const white = data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240;
                  return data[i + 3] > 200 && !white;
                })
              );
              if (solid) return { x: box.left + x / scale, y: box.top + y / scale };
            }
          }
        }
        return null;
      },
      null,
      { timeout: 15_000 }
    );
    const { x, y } = (await dot.jsonValue())!;

    const longest = await page.evaluate(() => (window as unknown as { __longest: number }).__longest);
    expect(longest, 'langste blokkade van de main thread (ms)').toBeLessThan(3000);

    await page.mouse.click(x, y);
    await expect(page.locator('.leaflet-popup-content')).not.toBeEmpty();
  });
});

test.describe('Adreszoeker', () => {
  test('toont PDOK-suggesties en selecteert een gemeente', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const input = page.getByPlaceholder('Zoek een adres of postcode...');
    await input.fill('Binnenhof 1');

    // The suggest call is debounced by 300 ms and then hits PDOK.
    const option = page.getByRole('option').first();
    await expect(option).toBeVisible({ timeout: 15_000 });

    await option.click();

    // Selecting resolves the id via lookup and moves the map; the input is
    // replaced by the resolved display name.
    await expect(input).not.toHaveValue('Binnenhof 1', { timeout: 15_000 });
  });
});

test.describe('Embed', () => {
  test('is inbedbaar in een iframe van een andere origin', async ({ page, request }) => {
    const response = await request.get('/embed');
    expect(response.status()).toBe(200);

    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain('frame-ancestors *');
    // X-Frame-Options has no "allow any origin" value, so it must be absent
    // here or browsers that prefer it will block the embed regardless of CSP.
    expect(response.headers()['x-frame-options']).toBeUndefined();

    await page.goto('/embed', { waitUntil: 'networkidle' });
    await expect(page.locator('.leaflet-container')).toBeVisible();
  });

  test('de gewone pagina is juist niet inbedbaar', async ({ request }) => {
    const response = await request.get('/');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

test.describe('Beveiligingsheaders', () => {
  test('staan op elke gewone route', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('geolocation=()');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
  });
});
