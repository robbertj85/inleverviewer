import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/react';

import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

// Point NEXT_PUBLIC_SITE_URL at the custom domain once one is configured;
// every canonical URL, OG tag and embed snippet reads from here.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://inleverpuntenviewer.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Inleverpuntenviewer — alle inleverpunten in Nederland op de kaart',
  description:
    'Bekijk en vergelijk 33.000+ inleverpunten in Nederland: statiegeld, batterijen, e-waste en milieustraten van Statiegeld Nederland, Stichting OPEN, Stibat, Droppie en StatieDrive — per gemeente op een interactieve kaart.',
  openGraph: {
    title: 'Inleverpuntenviewer — alle inleverpunten in Nederland',
    description:
      'Statiegeld, batterijen, e-waste en milieustraten: 33.000+ inleverpunten per gemeente op een interactieve kaart.',
    type: 'website',
    locale: 'nl_NL',
    url: siteUrl,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Inleverpunten',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#57802d',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="nl" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
