'use client';

import { ExternalLinkIcon } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MERK_COLORS, Merk } from '@/types/inleverpunten';

interface Source {
  merk: Merk | 'Gemeenten';
  naam: string;
  url: string;
  methode: string;
  omschrijving: string;
}

const SOURCES: Source[] = [
  {
    merk: 'StatiegeldNederland',
    naam: 'Statiegeld Nederland (Verpact)',
    url: 'https://www.statiegeldnederland.nl/locatiewijzer',
    methode: 'Publieke WFS (GeoServer)',
    omschrijving:
      'Alle statiegeldinnamepunten voor flessen, blikjes en kratten, met geaccepteerde materialen, uitbetaalmethoden en openingstijden. Verpact is de producentenorganisatie achter dit systeem.',
  },
  {
    merk: 'StichtingOPEN',
    naam: 'Stichting OPEN / Wecycle',
    url: 'https://inleverpunten.stichting-open.org',
    methode: 'Publieke REST API (bbox)',
    omschrijving:
      'Inleverpunten voor afgedankte elektrische apparaten en lampen, inclusief gemeentelijke milieustraten en recyclingstations.',
  },
  {
    merk: 'Stibat',
    naam: 'Stibat / Lege Batterijen',
    url: 'https://www.legebatterijen.nl/inleveren/waar-inleveren/',
    methode: 'Publieke REST API (straal)',
    omschrijving:
      'Inzamelbakken voor lege batterijen bij supermarkten, scholen, winkels en openbare gebouwen.',
  },
  {
    merk: 'Droppie',
    naam: 'Droppie',
    url: 'https://www.godroppie.com/nl/locaties',
    methode: 'Gestructureerde data (schema.org)',
    omschrijving:
      'Onbemande statiegeldautomaten waarbij uitbetaling via de Droppie-app verloopt.',
  },
  {
    merk: 'StatieDrive',
    naam: 'StatieDrive',
    url: 'https://www.statiedrive.nl/locaties',
    methode: 'Gestructureerde data (schema.org)',
    omschrijving:
      'Statiegeldretourshops waar je grotere hoeveelheden flessen, blikjes en kratten in één keer kunt inleveren.',
  },
  {
    merk: 'Gemeenten',
    naam: 'PDOK Bestuurlijke Gebieden & CBS',
    url: 'https://www.pdok.nl',
    methode: 'OGC API Features / CBS StatLine',
    omschrijving:
      'Officiële gemeentegrenzen van het Kadaster (PDOK) en inwoneraantallen van het CBS. De grenzen bepalen bij welke gemeente elk inleverpunt hoort.',
  },
];

export default function AboutModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Over de Inleverpuntenviewer</DialogTitle>
          <DialogDescription>
            Alle inleverpunten in Nederland op één kaart, per gemeente.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm leading-relaxed">
          <section>
            <p>
              Waar kun je je lege batterijen, kapotte föhn of statiegeldflessen kwijt? Die
              informatie staat verspreid over vijf verschillende locatiewijzers, elk met een eigen
              kaart en zonder exportmogelijkheid. Deze viewer brengt ze samen, koppelt elk punt
              aan een gemeente en maakt de data downloadbaar.
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-[var(--green-900)]">Databronnen</h3>
            <ul className="space-y-3">
              {SOURCES.map((source) => (
                <li key={source.naam} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{
                          background:
                            source.merk === 'Gemeenten'
                              ? 'var(--green-600)'
                              : MERK_COLORS[source.merk as Merk],
                        }}
                        aria-hidden
                      />
                      {source.naam}
                    </span>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                    >
                      Bron
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{source.omschrijving}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Methode: {source.methode}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-semibold text-[var(--green-900)]">
              Hoe de data tot stand komt
            </h3>
            <p className="text-muted-foreground">
              Elke maandagnacht worden alle bronnen opnieuw opgehaald. Ieder punt wordt via de
              officiële gemeentegrenzen aan een gemeente toegewezen. Daalt een bron met meer dan
              20% of levert hij niets op, dan blijft de vorige versie staan — zo kan één kapotte
              bron de rest van de dataset niet meeslepen.
            </p>
            <p className="mt-2 text-muted-foreground">
              De dekkingscirkels van 300, 400 en 500 meter worden live in je browser berekend op
              basis van de punten die je zichtbaar hebt. Ze zijn hemelsbreed, niet gecorrigeerd
              voor looproutes, water of hoogteverschil.
            </p>
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-semibold text-[var(--green-900)]">
              Beperkingen
            </h3>
            <ul className="list-inside list-disc space-y-1 text-muted-foreground">
              <li>
                Gemeentelijke milieustraten zijn vaak alleen toegankelijk voor inwoners van de
                betreffende gemeente. Dat staat bij het punt vermeld waar de bron het aangeeft.
              </li>
              <li>
                Openingstijden zijn alleen beschikbaar waar de bron ze levert, en kunnen
                verouderd zijn. Controleer bij twijfel de website van de locatie.
              </li>
              <li>
                Punten van verschillende bronnen op hetzelfde adres blijven aparte markers. Zet
                &lsquo;alleen gedeelde locaties&rsquo; aan om die plekken te vinden.
              </li>
              <li>
                Straatcontainers voor glas, textiel en papier zitten nog niet in deze dataset.
              </li>
            </ul>
          </section>

          <section className="rounded-lg bg-secondary p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Disclaimer</p>
            <p className="mt-1">
              Dit project wordt geleverd &lsquo;as is&rsquo;, zonder garantie. De data komt uit
              publieke bronnen en kan onnauwkeurigheden bevatten — verifieer locatiegegevens
              voordat je op pad gaat. Dit project is niet gelieerd aan de genoemde organisaties;
              merknamen en logo&rsquo;s zijn eigendom van de respectieve rechthebbenden.
            </p>
            <p className="mt-2">Gemeentegrenzen &copy; Kadaster / PDOK. Kaartmateriaal &copy; OpenStreetMap-bijdragers.</p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
