/**
 * Merged coverage rings, off the main thread.
 *
 * Unioning ~1.400 buffered points (Amsterdam) takes 2-3 s of Turf/polyclip
 * work. Done during render it held back every marker until the ring was
 * ready; here the points draw at once and the ring follows.
 *
 * In:  { coordinates: [lon, lat][], radiusKm }
 * Out: the merged Feature, or null when Turf gives up.
 */

import buffer from '@turf/buffer';
import union from '@turf/union';
import { featureCollection, point } from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

interface Request {
  coordinates: [number, number][];
  radiusKm: number;
}

/**
 * Union a list of buffered polygons pairwise.
 *
 * Turf's union takes a FeatureCollection, but folding thousands of polygons in
 * one call is slower (measured: 5.1 s against 2.5 s for Amsterdam) and prone to
 * topology errors. Halving the list each round keeps the individual unions small.
 */
function pairwiseUnion(
  features: Feature<Polygon | MultiPolygon>[]
): Feature<Polygon | MultiPolygon> | null {
  if (features.length === 0) return null;

  let current = features;
  while (current.length > 1) {
    const next: Feature<Polygon | MultiPolygon>[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 >= current.length) {
        next.push(current[i]);
        continue;
      }
      try {
        const merged = union(featureCollection([current[i], current[i + 1]]));
        next.push(merged ?? current[i]);
      } catch {
        // A self-intersecting pair should not kill the whole overlay.
        next.push(current[i]);
      }
    }
    current = next;
  }

  return current[0] ?? null;
}

// The DOM lib types `self` as a Window; inside a dedicated worker it is the
// worker scope, whose postMessage takes a single argument.
const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent<Request>) => {
  const { coordinates, radiusKm } = event.data;
  try {
    // steps:4 gives an octagon per point — indistinguishable from a circle
    // once merged, and far cheaper to union.
    const buffered = buffer(featureCollection(coordinates.map((c) => point(c))), radiusKm, {
      units: 'kilometers',
      steps: 4,
    });
    scope.postMessage(
      buffered && buffered.features.length > 0
        ? pairwiseUnion(buffered.features as Feature<Polygon | MultiPolygon>[])
        : null
    );
  } catch {
    scope.postMessage(null);
  }
};
