import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Voice of Octo', template: '%s · Voice of Octo' },
  description: 'Build, test and deploy voice agents.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1020' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* Applies the saved (or system) theme before the first paint: no flash of the wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
