import type { Metadata, Viewport } from 'next';

/**
 * CR-2026-106 — the public booking pages are opened from a phone link. Give them
 * their own metadata and a mobile viewport (the dashboard layout does not apply
 * here: these routes live outside the authenticated group).
 */
export const metadata: Metadata = {
  title: "Book a service appointment — Bert's Auto Parts Service Centre",
  description: 'Choose your vehicle, the service you need, and a time that suits you.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#1d4ed8',
};

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
