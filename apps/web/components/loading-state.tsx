'use client';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  return (
    <div className="card">
      <div className="px-6 py-12 text-center">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-slate-100 mb-4">
          <svg className="w-5 h-5 text-slate-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
        <p className="text-sm text-slate-500">{message}</p>
      </div>
    </div>
  );
}
