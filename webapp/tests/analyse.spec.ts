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

/**
 * The data tests walk every municipality's files, which on the full national
 * dataset means hundreds of thousands of individual checks. One Playwright
 * `expect()` per check took the suite past ten minutes, so these collect
 * violations with plain comparisons and assert once — which also reports
 * every failure instead of only the first.
 */
function expectNoProblems(problems: string[]) {
  const shown = problems.slice(0, 50);
  const more = problems.length > shown.length ? `\n… en nog ${problems.length - shown.length}` : '';
  expect(problems, `${problems.length} problemen:\n${shown.join('\n')}${more}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const TABS = [
  { path: '/data-export/schatting', heading: /Schatting inleverpunten per PC4/ },
  { path: '/data-export/bereik', heading: /Bereik van inwoners/ },
  { path: '/data-export/pois', heading: /Publieke POI/ },
  {
    path: '/data-export/suggesties',
    heading: /Plaatsingsadvies/,
    // Per-municipality advice only exists in data built since 2026-10-24;
    // an older dataset predates it.
    needs: ['placement_suggestions', 'index.json'],
  },
  { path: '/data-export/netwerkplanner', heading: /Netwerkplanner/ },
];

test.describe('Analysetabs', () => {
  for (const tab of TABS) {
    test(`${tab.path} laadt zonder console-fouten`, async ({ page }) => {
      test.skip(
        'needs' in tab && !exists(...(tab.needs as string[])),
        'dataset zonder deze laag'
      );
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

    // The provenance note is not decoration: the parcel data comes from
    // another project, as of a stated date, and the UI has to say so.
    await expect(page.getByText(/De pakketpuntendata komt uit/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Synergie/ })).toBeVisible();
  });

  test('netwerkplanner plant met alleen publiek of privaat terrein', async ({ page }) => {
    await page.goto('/data-export/netwerkplanner', { waitUntil: 'networkidle' });

    const publiek = page.getByRole('button', { name: /^Publiek terrein/ });
    // Network files from before the eigendom split have no switch.
    test.skip((await publiek.count()) === 0, 'netwerkdata zonder eigendomsvarianten');

    await publiek.click();
    const list = page.locator('ol').filter({ has: page.locator('li') }).last();
    await expect(list.locator('li').first()).toContainText('publiek');
    await expect(list).not.toContainText('privaat');

    await page.getByRole('button', { name: /^Privaat terrein/ }).click();
    await expect(list.locator('li').first()).toContainText('privaat');
    await expect(list).not.toContainText('publiek');
  });

  test('netwerkplanner tekent grafiek en kaart op ware grootte', async ({ page }) => {
    await page.goto('/data-export/netwerkplanner', { waitUntil: 'networkidle' });

    // Axis labels stay readable: the chart is drawn at the column's pixel
    // width instead of a scaled viewBox (which made them 24 px or 6 px).
    const label = page.locator('svg[aria-label^="Dekking"] text').first();
    const size = await label.evaluate((el) => el.getBoundingClientRect().height);
    expect(size).toBeGreaterThan(8);
    expect(size).toBeLessThan(18);

    // The basemap fills the map. It used to cover only a strip on the left:
    // Leaflet (and the MapLibre canvas following it) kept the size the
    // container had at mount. Element sizes looked right throughout, so this
    // checks pixels: the right third of the map must not be one flat colour.
    const container = page.locator('.leaflet-container').first();
    await page.getByRole('checkbox', { name: 'Bewoonde cellen' }).uncheck();
    await expect
      .poll(
        async () => {
          const png = (await container.screenshot()).toString('base64');
          return page.evaluate(async (data) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            const x0 = Math.floor((image.width * 2) / 3);
            const { data: px } = ctx.getImageData(x0, 0, image.width - x0, image.height);
            const colours = new Set<number>();
            for (let i = 0; i < px.length; i += 4 * 37) {
              colours.add((px[i] >> 3) * 1024 + (px[i + 1] >> 3) * 32 + (px[i + 2] >> 3));
            }
            return colours.size;
          }, png);
        },
        { timeout: 20_000, message: 'rechterdeel van de kaart blijft leeg' }
      )
      .toBeGreaterThan(20);
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
    const problems: string[] = [];
    for (const slug of Object.keys(index)) {
      const payload = readJson<{
        cells: { pop: number[] };
        scenarios: Record<string, { cell_rank: number[] }>;
        combi_scenarios: Record<string, { cell_rank_i: number[]; cell_rank_p: number[] }>;
      }>('inleverpunt_network', `${slug}.json`);
      const n = payload.cells.pop.length;

      for (const [key, scenario] of Object.entries(payload.scenarios)) {
        if (scenario.cell_rank.length !== n) {
          problems.push(`${slug} ${key}: ${scenario.cell_rank.length} rangen voor ${n} cellen`);
        }
      }
      for (const [key, scenario] of Object.entries(payload.combi_scenarios)) {
        if (scenario.cell_rank_i.length !== n || scenario.cell_rank_p.length !== n) {
          problems.push(
            `${slug} ${key}: ${scenario.cell_rank_i.length}/${scenario.cell_rank_p.length} rangen voor ${n} cellen`
          );
        }
      }
    }
    expectNoProblems(problems);
  });

  test('de synergie-index klopt met de twee winsten', () => {
    const index = readJson<Record<string, unknown>>('inleverpunt_network', 'index.json');
    const problems: string[] = [];
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
          if (Math.abs(pick.synergie - expected) > 0.0005 + 1e-9) {
            problems.push(`${slug} ${key}: synergie ${pick.synergie} vs ${expected}`);
          }
        }
      }
    }
    expectNoProblems(problems);
  });

  test('de synergie-regel kiest alleen locaties die beide functies aankunnen', () => {
    const index = readJson<Record<string, unknown>>('inleverpunt_network', 'index.json');
    const problems: string[] = [];
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
          if (!payload.type_meta[type].combi_geschikt) {
            problems.push(`${slug} ${key} koos ${type}, dat geen pakketpunt kan huisvesten`);
          }
        }
      }
    }
    expectNoProblems(problems);
  });

  test('elk plaatsingsadvies verwijst naar een bestaand PC4 met een gastheer of een reden', () => {
    // Older datasets predate the per-municipality files.
    test.skip(
      !exists('placement_suggestions', 'index.json'),
      'dataset zonder plaatsingsadvies per gemeente'
    );
    const index = readJson<{
      streams: string[];
      poi_snap_max_m: number;
      pakket_hosts: string[];
      municipalities: Record<string, { variants: string[] }>;
    }>('placement_suggestions', 'index.json');

    expect(index.streams).toContain('alle');
    const slugs = Object.keys(index.municipalities);
    expect(slugs.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const slug of slugs) {
      const payload = readJson<{
        variants: Record<
          string,
          {
            layers: string[];
            pc4s: {
              pc4: string;
              suggestions: Record<
                string,
                {
                  snapped: boolean;
                  poi_category: string | null;
                  poi_distance_m: number | null;
                  poi_eigendom: string | null;
                  lat: number;
                  lon: number;
                }[]
              >;
            }[];
          }
        >;
      }>('placement_suggestions', `${slug}.json`);

      for (const [key, block] of Object.entries(payload.variants)) {
        for (const record of block.pc4s) {
          if (!/^\d{4}$/.test(record.pc4)) problems.push(`${slug}/${key}: PC4 ${record.pc4}`);
          for (const [terrain, spots] of Object.entries(record.suggestions)) {
            for (const suggestion of spots) {
              const where = `${slug}/${key}/${terrain}/${record.pc4}`;
              // Inside the Netherlands, roughly.
              if (
                !(suggestion.lat > 50.5 && suggestion.lat < 53.8) ||
                !(suggestion.lon > 3.2 && suggestion.lon < 7.3)
              ) {
                problems.push(`${where}: buiten Nederland (${suggestion.lat}, ${suggestion.lon})`);
              }
              // A snapped suggestion sits on a real host within the walking
              // threshold; an unsnapped one must not claim it does.
              if (
                suggestion.snapped &&
                (suggestion.poi_distance_m == null ||
                  suggestion.poi_distance_m > index.poi_snap_max_m)
              ) {
                problems.push(`${where}: gesnapt op ${suggestion.poi_distance_m} m`);
              }
              // A terrain choice only ever lands on that terrain.
              if (terrain !== 'mix' && suggestion.poi_category && suggestion.poi_eigendom !== terrain) {
                problems.push(`${where}: gastheer op ${suggestion.poi_eigendom} terrein`);
              }
              // With parcel points, the host must be able to take one too.
              if (
                block.layers.includes('pakket') &&
                suggestion.poi_category &&
                !index.pakket_hosts.includes(suggestion.poi_category)
              ) {
                problems.push(`${where}: ${suggestion.poi_category} kan geen pakketpunt huisvesten`);
              }
            }
          }
        }
      }
    }
    expectNoProblems(problems);
  });
});
