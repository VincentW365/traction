'use client';

import { useEffect } from 'react';

export default function DisplayError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Display board error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="text-3xl font-bold text-red-400 mb-4">⚠️</div>
        <h1 className="text-2xl font-bold text-slate-200 mb-2">Display Error</h1>
        <p className="text-slate-400 mb-6">The service board encountered an error and cannot display.</p>
        <button
          onClick={reset}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
