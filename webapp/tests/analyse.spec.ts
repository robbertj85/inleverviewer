import fs from 'fs';
import path from 'path';
import { test, expect, type ConsoleMessage } from '@playwright/test';

import { SUBSETS, type Subset } from '../types/analyse';

/**
 * The five analysis tabs.
 *
 * Two kinds of check, and the second is the one that earns its keep. The page
 * tests confirm each tab renders its dataset. The data tests confirm the
 * Python pipeline and the TypeScript agree on the subset vocabulary and that
 * every municipality the pipeline claims to cover actually has its files —
 * the sister pakketpunten project silently lost four municipalities from its
 * network planner to a slug mismatch, and the only symptom was one skipped
 * line in a 342-line log.
 */

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

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

function readJson<T>(...segments: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, ...segments), 'utf-8')) as T;
}

function exists(...segments: string[]): boolean {
  return fs.existsSync(path.join(DATA_DIR, ...segments));
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const TABS = [
  { path: '/data-export/schatting', heading: /Schatting inleverpunten per PC4/ },
  { path: '/data-export/bereik', heading: /Bereik van inwoners/ },
  { path: '/data-export/pois', heading: /Publieke POI/ },
  { path: '/data-export/suggesties', heading: /Plaatsingsadvies/ },
  { path: '/data-export/netwerkplanner', heading: /Netwerkplanner/ },
];

test.describe('Analysetabs', () => {
  for (const tab of TABS) {
    test(`${tab.path} laadt zonder console-fouten`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.goto(tab.path, { waitUntil: 'networkidle' });

      await expect(page.getByRole('heading', { name: tab.heading })).toBeVisible();
      // The amber "dataset ontbreekt" fallback renders a heading too, so
      // assert the placeholder is *not* what we are looking at.
      await expect(page.getByText(/ontbreekt|Nog geen netwerkdata/)).toHaveCount(0);

      expect(errors, `Onverwachte console-fouten:\n${errors.join('\n')}`).toEqual([]);
    });
  }

  test('de analysestrip linkt naar alle vijf de tabs', async ({ page }) => {
    await page.goto('/data-export/bereik', { waitUntil: 'domcontentloaded' });
    const strip = page.getByRole('navigation', { name: 'Analyse' });
    for (const tab of TABS) {
      await expect(strip.locator(`a[href="${tab.path}"]`)).toHaveCount(1);
    }
  });

  test('bereik toont landelijke dekking en reageert op de subsetkeuze', async ({ page }) => {
    await page.goto('/data-export/bereik', { waitUntil: 'networkidle' });

    const summary = page.getByRole('heading', { name: /Landelijk —/ });
    await expect(summary).toContainText('Alle inleverpunten');

    await page.getByRole('button', { name: 'Statiegeld', exact: true }).click();
    await expect(summary).toContainText('Statiegeld');
  });

  test('netwerkplanner schakelt naar de gecombineerde modus', async ({ page }) => {
    await page.goto('/data-export/netwerkplanner', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Inleverpunt + pakketpunt' }).click();

    // The snapshot disclaimer is not decoration: the parcel data comes from
    // another repository and the UI has to say so.
    await expect(page.getByText(/momentopname/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Synergie/ })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

test.describe('Analysedata', () => {
  test('population_coverage dekt elk subset uit de gedeelde woordenlijst', () => {
    const payload = readJson<{
      subsets: Subset[];
      national: Record<string, unknown>;
      municipalities: Record<string, { national: Record<string, unknown> }>;
      pc4: Record<string, Record<string, unknown>>;
    }>('population_coverage.json');

    // normalize.py and types/analyse.ts define the subsets separately. A
    // subset added on one side only would silently drop out of the UI.
    expect([...payload.subsets].sort()).toEqual([...SUBSETS].sort());

    for (const subset of SUBSETS) {
      expect(payload.national[subset], `landelijk mist ${subset}`).toBeTruthy();
    }

    const [firstMuni] = Object.values(payload.municipalities);
    for (const subset of SUBSETS) {
      expect(firstMuni.national[subset], `gemeente mist ${subset}`).toBeTruthy();
    }
  });

  test('milieustraten tellen niet over de gemeentegrens heen', () => {
    const payload = readJson<{
      national: Record<string, Record<string, { pct: number }>>;
    }>('population_coverage.json');

    // 390 municipal recycling centres, each restricted to its own residents.
    // If this ever climbs near the other subsets, the gemeenteBeperking
    // handling in compute_population_coverage.py has stopped applying.
    const milieustraat = payload.national.milieustraat['400m'].pct;
    const inzamelbak = payload.national.inzamelbak['400m'].pct;
    expect(milieustraat).toBeGreaterThan(0);
    expect(milieustraat).toBeLessThan(inzamelbak / 4);
  });

  test('elk model rapporteert een cross-gevalideerde R² naast de in-sample R²', () => {
    const payload = readJson<{
      models: Record<string, Record<string, { r2: number; r2_cv_mean: number } | string>>;
    }>('pc4_stats.json');

    for (const [target, sets] of Object.entries(payload.models)) {
      for (const [name, model] of Object.entries(sets)) {
        if (name === 'recommended' || model == null || typeof model === 'string') continue;
        expect(model.r2, `${target}/${name} mist r2`).toBeGreaterThan(0);
        expect(
          model.r2_cv_mean,
          `${target}/${name} mist een cross-validatiescore`
        ).toBeGreaterThan(0);
        // In-sample R² is an upper bound on the cross-validated one. If this
        // ever inverts, the folds are leaking.
        expect(model.r2_cv_mean).toBeLessThanOrEqual(model.r2 + 1e-9);
      }
    }
  });

  test('elke geplande gemeente heeft een POI-bundel en een netwerkbestand', () => {
    const index = readJson<Record<string, { gemeente: string; has_combi: boolean }>>(
      'inleverpunt_network', 'index.json'
    );
    expect(Object.keys(index).length).toBeGreaterThan(0);

    for (const slug of Object.keys(index)) {
      expect(exists('inleverpunt_network', `${slug}.json`), `${slug}.json ontbreekt`).toBe(true);
      expect(exists('poi', 'by-municipality', `${slug}.geojson`), `POI-bundel voor ${slug} ontbreekt`).toBe(true);
      expect(exists(`${slug}.geojson`), `gemeente-GeoJSON voor ${slug} ontbreekt`).toBe(true);
    }
  });

  test('cell_rank heeft precies één waarde per cel in elk scenario', () => {
    const index = readJson<Record<string, unknown>>('inleverpunt_network', 'index.json');
    for (const slug of Object.keys(index)) {
      const payload = readJson<{
        cells: { pop: number[] };
        scenarios: Record<string, { cell_rank: number[] }>;
        combi_scenarios: Record<string, { cell_rank_i: number[]; cell_rank_p: number[] }>;
      }>('inleverpunt_network', `${slug}.json`);
      const n = payload.cells.pop.length;

      for (const [key, scenario] of Object.entries(payload.scenarios)) {
        expect(scenario.cell_rank.length, `${slug} ${key}`).toBe(n);
      }
      for (const [key, scenario] of Object.entries(payload.combi_scenarios)) {
        expect(scenario.cell_rank_i.length, `${slug} ${key} (inleveren)`).toBe(n);
        expect(scenario.cell_rank_p.length, `${slug} ${key} (pakketten)`).toBe(n);
      }
    }
  });

  test('de synergie-index klopt met de twee winsten', () => {
    const index = readJson<Record<string, unknown>>('inleverpunt_network', 'index.json');
    for (const slug of Object.keys(index)) {
      const payload = readJson<{
        combi_scenarios: Record<
          string,
          { picks: { gain_i: number; gain_p: number; synergie: number }[] }
        >;
      }>('inleverpunt_network', `${slug}.json`);

      for (const [key, scenario] of Object.entries(payload.combi_scenarios)) {
        for (const pick of scenario.picks) {
          const sum = pick.gain_i + pick.gain_p;
          const expected =
            sum > 0 ? (2 * Math.min(pick.gain_i, pick.gain_p)) / sum : 0;
          // Stored rounded to three decimals, so anything within half a unit
          // of the last decimal is exact. toBeCloseTo(x, 3) is tighter than
          // that and trips on values that sit on the rounding boundary.
          expect(
            Math.abs(pick.synergie - expected),
            `${slug} ${key}: synergie ${pick.synergie} vs ${expected}`
          ).toBeLessThanOrEqual(0.0005 + 1e-9);
        }
      }
    }
  });

  test('de synergie-regel kiest alleen locaties die beide functies aankunnen', () => {
    const index = readJson<Record<string, unknown>>('inleverpunt_network', 'index.json');
    for (const slug of Object.keys(index)) {
      const payload = readJson<{
        type_meta: Record<string, { combi_geschikt: boolean }>;
        candidates: { type: string }[];
        combi_scenarios: Record<string, { rule: string; picks: { c: number }[] }>;
      }>('inleverpunt_network', `${slug}.json`);

      for (const [key, scenario] of Object.entries(payload.combi_scenarios)) {
        if (scenario.rule !== 'synergie') continue;
        for (const pick of scenario.picks) {
          const type = payload.candidates[pick.c].type;
          expect(
            payload.type_meta[type].combi_geschikt,
            `${slug} ${key} koos ${type}, dat geen pakketpunt kan huisvesten`
          ).toBe(true);
        }
      }
    }
  });

  test('elk plaatsingsadvies verwijst naar een bestaand PC4 met een gastheer of een reden', () => {
    const payload = readJson<{
      streams: string[];
      poi_snap_max_m: number;
      by_stream: Record<
        string,
        Record<
          string,
          {
            pc4s: {
              pc4: string;
              suggestions: {
                snapped: boolean;
                poi_distance_m: number | null;
                lat: number;
                lon: number;
              }[];
            }[];
          }
        >
      >;
    }>('placement_suggestions.json');

    expect(payload.streams.length).toBeGreaterThan(0);

    for (const [stream, munis] of Object.entries(payload.by_stream)) {
      for (const [slug, block] of Object.entries(munis)) {
        for (const record of block.pc4s) {
          expect(record.pc4).toMatch(/^\d{4}$/);
          for (const suggestion of record.suggestions) {
            // Inside the Netherlands, roughly.
            expect(suggestion.lat).toBeGreaterThan(50.5);
            expect(suggestion.lat).toBeLessThan(53.8);
            expect(suggestion.lon).toBeGreaterThan(3.2);
            expect(suggestion.lon).toBeLessThan(7.3);
            // A snapped suggestion sits on a real host within the walking
            // threshold; an unsnapped one must not claim it does.
            if (suggestion.snapped) {
              expect(
                suggestion.poi_distance_m,
                `${stream}/${slug}/${record.pc4} gesnapt zonder gastheer`
              ).not.toBeNull();
              expect(suggestion.poi_distance_m!).toBeLessThanOrEqual(
                payload.poi_snap_max_m
              );
            }
          }
        }
      }
    }
  });
});
