'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeftIcon,
  BarChart3Icon,
  DownloadIcon,
  LayersIcon,
  RefreshCwIcon,
  ShareIcon,
  SparklesIcon,
  TableIcon,
  TargetIcon,
  TrendingUpIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

interface Tab {
  href: string;
  label: string;
  icon: typeof DownloadIcon;
  /** Beta tabs are model output, not measurement. The badge says so. */
  beta?: boolean;
  /** Sub-routes that should keep this tab highlighted. */
  prefix?: boolean;
}

const DATA_TABS: Tab[] = [
  { href: '/data-export', label: 'Downloads', icon: DownloadIcon },
  { href: '/data-export/matrix', label: 'Data matrix', icon: TableIcon },
  { href: '/data-export/statistieken', label: 'Statistieken', icon: BarChart3Icon },
  { href: '/data-export/updates', label: 'Updates', icon: RefreshCwIcon },
];

const ANALYSE_TABS: Tab[] = [
  {
    href: '/data-export/schatting',
    label: 'Schatting inleverpunten',
    icon: TrendingUpIcon,
    beta: true,
  },
  {
    href: '/data-export/bereik',
    label: 'Bereik inwoners',
    icon: TargetIcon,
    beta: true,
  },
  {
    href: '/data-export/pois',
    label: "Publieke POI's",
    icon: LayersIcon,
    beta: true,
  },
  {
    href: '/data-export/suggesties',
    label: 'Plaatsingsadvies',
    icon: SparklesIcon,
    beta: true,
    prefix: true,
  },
  {
    href: '/data-export/netwerkplanner',
    label: 'Netwerkplanner',
    icon: ShareIcon,
    beta: true,
    prefix: true,
  },
];

function isActive(tab: Tab, pathname: string): boolean {
  return tab.prefix ? pathname.startsWith(tab.href) : pathname === tab.href;
}

export default function DataExportLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const activeTabRef = useRef<HTMLAnchorElement>(null);

  // The tab strip scrolls on narrow phones, where the last tab starts
  // off-screen. Without this, landing on /updates shows no active tab at all.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  const onAnalyse = ANALYSE_TABS.some((tab) => isActive(tab, pathname));

  const renderTab = (tab: Tab) => {
    const active = isActive(tab, pathname);
    const Icon = tab.icon;
    return (
      <Link
        key={tab.href}
        href={tab.href}
        ref={active ? activeTabRef : undefined}
        className={cn(
          'flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm font-medium transition-colors sm:px-3',
          active
            ? 'border-primary text-primary'
            : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
        )}
      >
        <Icon className="size-4" />
        {tab.label}
        {tab.beta && (
          <span className="rounded border border-[var(--green-300)] bg-[var(--green-50)] px-1 py-px align-middle text-[9px] font-semibold uppercase tracking-wide text-[var(--green-800)]">
            beta
          </span>
        )}
      </Link>
    );
  };

  return (
    <div className="min-h-screen bg-muted">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-[1600px] px-4 py-4">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-[var(--green-900)] md:text-2xl">
                Inleverpunten — Data
              </h1>
              <p className="text-sm text-muted-foreground">
                Download de data, vergelijk gemeenten en bekijk de updatestatus.
              </p>
            </div>
            {/* -mr-2 keeps the enlarged hit area from pushing the layout */}
            <Link
              href="/"
              aria-label="Terug naar kaart"
              className="-mr-2 flex min-h-11 shrink-0 items-center gap-1.5 px-2 text-sm font-medium text-primary hover:underline"
            >
              <ArrowLeftIcon className="size-4" />
              <span className="hidden sm:inline">Terug naar kaart</span>
            </Link>
          </div>

          {/*
            Two strips rather than one. Nine tabs on one line pushes the last
            four off-screen even on a laptop, and the split is meaningful: the
            first row is the measured dataset, the second is what we model on
            top of it.
          */}
          <nav
            aria-label="Data"
            className="scrollbar-hide flex gap-1 overflow-x-auto border-b border-border"
          >
            {DATA_TABS.map(renderTab)}
          </nav>
          <nav
            aria-label="Analyse"
            className="scrollbar-hide -mb-px mt-1 flex items-center gap-1 overflow-x-auto border-b border-border"
          >
            <span
              className={cn(
                'shrink-0 pl-1 pr-2 text-[11px] font-semibold uppercase tracking-wide',
                onAnalyse ? 'text-[var(--green-800)]' : 'text-muted-foreground'
              )}
            >
              Analyse
            </span>
            {ANALYSE_TABS.map(renderTab)}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
    </div>
  );
}
