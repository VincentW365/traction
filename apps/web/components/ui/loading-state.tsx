'use client';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  return (
    <div className="card flex items-center justify-center py-16">
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
        <span className="text-sm text-slate-500">{message}</span>
      </div>
    </div>
  );
}
