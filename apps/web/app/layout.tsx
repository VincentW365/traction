import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '../components/providers';

export const metadata: Metadata = {
  title: 'Traction — Service Operations',
  description: "Traction — Bert's Auto Parts Service Operations Platform",
  icons: { icon: '/logo.png' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased bg-gray-50">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
