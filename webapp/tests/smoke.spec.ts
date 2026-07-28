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
 * Vercel Analytics loads /_vercel/insights/script.js, which only exists once
 * deployed. Locally it 404s to an HTML page, which the browser reports twice:
 * once as a bare "Failed to load resource ... 404" with no URL in the text, and
 * once as "Refused to execute script ... MIME type". Neither names our code, so
 * both have to be matched loosely here — the precise assertions live in the
 * response and CSP checks below, which match on URL rather than on prose.
 */
const IGNORED_ERRORS = [
  /_vercel\/insights/i,
  /vercel.*analytics/i,
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
      if (response.url().includes('/_vercel/')) return;
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
      // enough: the browser uses the same opening for a MIME-type refusal, and
      // Vercel Analytics 404ing to an HTML page triggers exactly that locally.
      if (/Content Security Policy/i.test(text)) blocked.push(text);
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    expect(blocked, `CSP blokkeerde resources:\n${blocked.join('\n')}`).toEqual([]);
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
