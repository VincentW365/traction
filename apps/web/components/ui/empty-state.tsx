'use client';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="card flex flex-col items-center justify-center py-12 px-6 text-center">
      {icon && <div className="text-slate-300 mb-3">{icon}</div>}
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      {description && <p className="text-xs text-slate-400 mt-1 max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
