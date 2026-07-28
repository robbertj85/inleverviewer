import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

import municipalities from '../public/municipalities.json';
import {
  ALL_CATEGORIEEN,
  ALL_MATERIALEN,
  ALL_MERKEN,
} from '../types/inleverpunten';

/**
 * Structural checks over every generated GeoJSON file.
 *
 * Reads from disk rather than over HTTP: this is about what the Python
 * pipeline produced, not about how Next serves it, and 343 files go past in a
 * couple of seconds this way.
 *
 * The vocabulary assertions are the valuable ones. `normalize.py` and
 * types/inleverpunten.ts define brands, materials and categories separately,
 * and `make_record` silently discards terms it does not recognise — so a term
 * added on the Python side without its TypeScript counterpart makes points
 * quietly vanish from the filters. That desync has no other symptom.
 */

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

interface Feature {
  type: string;
  geometry: { type: string; coordinates: number[] };
  properties: Record<string, unknown>;
}

const KNOWN_MERKEN = new Set<string>(ALL_MERKEN);
const KNOWN_MATERIALEN = new Set<string>(ALL_MATERIALEN);
const KNOWN_CATEGORIEEN = new Set<string>(ALL_CATEGORIEEN);

// The national file is generated with address, opening-hours and payout fields
// stripped ("reduced": true), so it is checked separately from the per-
// municipality files rather than held to the same shape.
const perMunicipality = municipalities.filter((m) => m.slug !== 'nederland');

test.describe('Gegenereerde GeoJSON', () => {
  test('elke gemeente in de index heeft een bestand', () => {
    const missing = perMunicipality
      .map((m) => m.slug)
      .filter((slug) => !fs.existsSync(path.join(DATA_DIR, `${slug}.geojson`)));

    expect(missing, `Ontbrekende bestanden: ${missing.join(', ')}`).toEqual([]);
  });

  test('alle bestanden zijn geldige FeatureCollections binnen Nederland', () => {
    const problems: string[] = [];

    for (const municipality of perMunicipality) {
      const filePath = path.join(DATA_DIR, `${municipality.slug}.geojson`);
      if (!fs.existsSync(filePath)) continue;

      let parsed: { type: string; features: Feature[]; metadata?: Record<string, unknown> };
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (error) {
        problems.push(`${municipality.slug}: onleesbaar (${(error as Error).message})`);
        continue;
      }

      if (parsed.type !== 'FeatureCollection') {
        problems.push(`${municipality.slug}: type is ${parsed.type}`);
        continue;
      }

      const points = parsed.features.filter((f) => f.properties?.type === 'inleverpunt');

      for (const feature of points) {
        const [lon, lat] = feature.geometry.coordinates;

        // WGS84 degrees, roughly the Dutch bounding box. RD New metres landing
        // in this field is the mistake this catches.
        if (!(lon > 3 && lon < 8 && lat > 50 && lat < 54)) {
          problems.push(
            `${municipality.slug}: punt buiten Nederland (${lat}, ${lon}) — ${feature.properties.locatieNaam}`
          );
          break;
        }
      }
    }

    expect(problems, `Problemen:\n${problems.join('\n')}`).toEqual([]);
  });

  test('gebruikt alleen termen die de webapp kent', () => {
    const unknownMerken = new Set<string>();
    const unknownMaterialen = new Set<string>();
    const unknownCategorieen = new Set<string>();

    for (const municipality of perMunicipality) {
      const filePath = path.join(DATA_DIR, `${municipality.slug}.geojson`);
      if (!fs.existsSync(filePath)) continue;

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        features: Feature[];
      };

      for (const feature of parsed.features) {
        if (feature.properties?.type !== 'inleverpunt') continue;

        const merk = feature.properties.merk as string;
        if (merk && !KNOWN_MERKEN.has(merk)) unknownMerken.add(merk);

        const puntType = feature.properties.puntType as string;
        if (puntType && !KNOWN_CATEGORIEEN.has(puntType)) unknownCategorieen.add(puntType);

        const materialen = (feature.properties.materialen as string[]) ?? [];
        for (const materiaal of materialen) {
          if (!KNOWN_MATERIALEN.has(materiaal)) unknownMaterialen.add(materiaal);
        }
      }
    }

    expect(
      [...unknownMerken],
      'Merken in de data die types/inleverpunten.ts niet kent'
    ).toEqual([]);
    expect(
      [...unknownCategorieen],
      'Categorieën in de data die types/inleverpunten.ts niet kent'
    ).toEqual([]);
    expect(
      [...unknownMaterialen],
      'Materialen in de data die types/inleverpunten.ts niet kent'
    ).toEqual([]);
  });

  test('het landelijke bestand is het gereduceerde bestand', () => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'nederland.geojson'), 'utf-8')
    ) as { metadata?: { reduced?: boolean }; features: Feature[] };

    expect(parsed.metadata?.reduced).toBe(true);

    // Reduced means these fields are dropped on purpose; if they come back the
    // national file has silently doubled in size.
    const [first] = parsed.features.filter((f) => f.properties?.type === 'inleverpunt');
    expect(first.properties.openingstijden).toBeUndefined();
    expect(first.properties.straatNaam).toBeUndefined();
  });
});
