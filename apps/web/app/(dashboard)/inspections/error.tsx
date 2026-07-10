'use client';

import { useEffect } from 'react';

export default function InspectionsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Inspections page error:', error);
  }, [error]);

  return (
    <div className="page-container">
      <div className="max-w-2xl mx-auto">
        <div className="card p-8 border-red-200 bg-red-50">
          <div className="flex gap-4">
            <div className="text-3xl flex-shrink-0">⚠️</div>
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-red-900 mb-2">Something went wrong</h1>
              <p className="text-red-800 mb-6">The inspections page encountered an error. Please try again.</p>
              <button
                onClick={reset}
                className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
