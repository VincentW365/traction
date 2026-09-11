'use client';

import { useEffect } from 'react';

export default function BookError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Booking page error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Something went wrong</h1>
        <p className="text-slate-600 mb-6">We could not load the booking page. Please try again, or call the service centre to book.</p>
        <button onClick={reset} className="btn-primary">Try again</button>
      </div>
    </div>
  );
}
