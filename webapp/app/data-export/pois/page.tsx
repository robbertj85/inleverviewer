'use client';

import dynamic from 'next/dynamic';

// Leaflet touches `window` on import, so the explorer only loads client-side.
const PoiExplorer = dynamic(() => import('@/components/analyse/PoiExplorer'), {
  ssr: false,
  loading: () => (
    <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
      Kaart laden…
    </div>
  ),
});

export default function PoisPage() {
  return <PoiExplorer />;
}
