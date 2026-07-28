import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'API-documentatie — Inleverpunten API',
  description:
    'REST API voor inleverpunten in Nederland: statiegeld, batterijen, e-waste en milieustraten per gemeente.',
};

export default function ApiDocsPage() {
  const theme = JSON.stringify({
    colors: {
      primary: { main: '#57802d' },
    },
    typography: {
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      headings: { fontWeight: '600' },
    },
    sidebar: {
      backgroundColor: '#f4f8ee',
      activeTextColor: '#57802d',
    },
  });

  return (
    <div style={{ margin: 0, minHeight: '100vh' }}>
      {/* Redoc renders the spec into this custom element once its bundle loads. */}
      <div
        dangerouslySetInnerHTML={{
          __html: `<redoc spec-url="/openapi.yaml" theme='${theme}' expand-responses="200" required-props-first="true" hide-download-button="false"></redoc>`,
        }}
      />
      <Script
        src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"
        strategy="afterInteractive"
      />
    </div>
  );
}
