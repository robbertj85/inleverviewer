'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeftIcon,
  BarChart3Icon,
  DownloadIcon,
  RefreshCwIcon,
  TableIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const TABS = [
  { href: '/data-export', label: 'Downloads', icon: DownloadIcon },
  { href: '/data-export/matrix', label: 'Data matrix', icon: TableIcon },
  { href: '/data-export/statistieken', label: 'Statistieken', icon: BarChart3Icon },
  { href: '/data-export/updates', label: 'Updates', icon: RefreshCwIcon },
];

export default function DataExportLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const activeTabRef = useRef<HTMLAnchorElement>(null);

  // The tab strip scrolls on narrow phones, where the last tab starts
  // off-screen. Without this, landing on /updates shows no active tab at all.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

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

          <nav className="scrollbar-hide -mb-px flex gap-1 overflow-x-auto border-b border-border">
            {TABS.map((tab) => {
              const active = pathname === tab.href;
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
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
    </div>
  );
}
