'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircleIcon, CheckCircle2Icon, DownloadIcon, InfoIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Municipality } from '@/types/inleverpunten';

type Status = { kind: 'ok' | 'warn' | 'error'; message: string } | null;

export default function DownloadsPage() {
  const [municipalities, setMunicipalities] = useState<Municipality[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState<{ points: number; municipalities: number } | null>(null);

  useEffect(() => {
    fetch('/municipalities.json')
      .then((res) => res.json())
      .then(setMunicipalities)
      .catch((error) => console.error('Kon gemeentelijst niet laden:', error));

    // The batch summary is cheaper to read than the 11 MB national GeoJSON.
    fetch('/data/summary.json')
      .then((res) => res.json())
      .then((summary) =>
        setTotals({
          points: summary.total_points ?? 0,
          municipalities: summary.total_municipalities ?? 0,
        })
      )
      .catch(() => setTotals(null));
  }, []);

  const national = municipalities.find((m) => m.slug === 'nederland');
  const cities = useMemo(() => {
    const list = municipalities.filter((m) => m.slug !== 'nederland');
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) ||
        m.province.toLowerCase().includes(needle) ||
        (m.code ?? '').toLowerCase().includes(needle)
    );
  }, [municipalities, query]);

  const download = async (slug: string, format: 'json' | 'csv') => {
    setBusy(true);
    setStatus(null);

    try {
      const response = await fetch(`/api/download?slug=${slug}&format=${format}`);

      if (response.status === 429) {
        setStatus({
          kind: 'warn',
          message: 'Te veel downloads. Probeer het later opnieuw (max. 10 per uur).',
        });
        return;
      }

      if (!response.ok) throw new Error(await response.text());

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `inleverpunten-${slug}.${format === 'json' ? 'geojson' : 'csv'}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setStatus({ kind: 'ok', message: 'Download gestart.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: `Download mislukt: ${error instanceof Error ? error.message : 'onbekende fout'}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {status && (
        <div
          className={
            status.kind === 'ok'
              ? 'flex items-center gap-2 rounded-lg bg-[var(--green-50)] px-4 py-3 text-sm text-[var(--green-900)]'
              : status.kind === 'warn'
                ? 'flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900'
                : 'flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900'
          }
        >
          {status.kind === 'ok' ? (
            <CheckCircle2Icon className="size-4 shrink-0" />
          ) : (
            <AlertCircleIcon className="size-4 shrink-0" />
          )}
          {status.message}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-lg font-bold text-[var(--green-900)]">Landelijke data</h2>
        <Card>
          <CardContent className="flex flex-col items-start justify-between gap-4 p-4 sm:flex-row sm:items-center">
            <div>
              <h3 className="font-semibold">{national?.name ?? 'Nederland (totaal)'}</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Alle {totals?.municipalities ?? 342} gemeenten, toegewezen via de officiële
                gemeentegrenzen.
              </p>
              {totals && (
                <p className="mt-1.5 text-sm font-semibold tabular-nums text-[var(--green-900)]">
                  {totals.points.toLocaleString('nl-NL')} inleverpunten
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Het landelijke bestand bevat geen adres-, openingstijd- en uitbetalingsvelden.
                Download een gemeente voor de volledige gegevens.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => download('nederland', 'json')} disabled={busy}>
                <DownloadIcon />
                GeoJSON
              </Button>
              <Button
                variant="outline"
                onClick={() => download('nederland', 'csv')}
                disabled={busy}
              >
                <DownloadIcon />
                CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold text-[var(--green-900)]">Per gemeente</h2>
        <Card>
          <CardHeader>
            <CardTitle className="sr-only">Gemeenten</CardTitle>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Zoek gemeente, provincie of CBS-code..."
            />
          </CardHeader>
          <CardContent>
            <div className="max-h-[32rem] divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {cities.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Geen gemeente gevonden.
                </p>
              )}
              {cities.map((municipality) => (
                <div
                  key={municipality.slug}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-secondary"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{municipality.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {municipality.province} · {municipality.population.toLocaleString('nl-NL')}{' '}
                      inwoners
                      {municipality.code ? ` · ${municipality.code}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => download(municipality.slug, 'json')}
                      disabled={busy}
                    >
                      GeoJSON
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => download(municipality.slug, 'csv')}
                      disabled={busy}
                    >
                      CSV
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-4 text-sm">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <p className="font-medium">Downloadlimiet en hergebruik</p>
          <p className="mt-1 text-muted-foreground">
            Maximaal 10 downloads per uur per IP-adres. Dezelfde data is ook beschikbaar via de{' '}
            <a href="/api/v1/docs" className="text-primary hover:underline">
              API
            </a>
            . Vermeld bij hergebruik de oorspronkelijke bronnen: Statiegeld Nederland (Verpact),
            Stichting OPEN / Wecycle, Stibat, Droppie en StatieDrive. Gemeentegrenzen &copy;
            Kadaster / PDOK.
          </p>
        </div>
      </div>
    </div>
  );
}
