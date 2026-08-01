/**
 * Metadata for the POI tab.
 *
 * Lives in a layout because the page itself has to be a Client Component —
 * Leaflet touches `window` on import, so the explorer is loaded with
 * `dynamic(..., { ssr: false })`, and a Client Component cannot export
 * `metadata`. Without this the tab inherits the site-wide title.
 */
export const metadata = {
  title: "Publieke POI's — Inleverpunten",
  description:
    'Kandidaat-locaties voor een inleverpunt uit OpenStreetMap, met de bestaande punten eroverheen.',
};

export default function PoisLayout({ children }: { children: React.ReactNode }) {
  return children;
}
