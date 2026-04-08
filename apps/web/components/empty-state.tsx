'use client';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="card">
      <div className="px-6 py-12 text-center">
        {icon && <div className="flex justify-center mb-4 text-slate-400">{icon}</div>}
        <h3 className="text-lg font-semibold text-slate-700">{title}</h3>
        {description && <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">{description}</p>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}
