'use client';

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
}

export function StatCard({ label, value, icon }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between">
        <div>
          <div className="stat-value">{value}</div>
          <div className="stat-label">{label}</div>
        </div>
        {icon && <div className="text-slate-400">{icon}</div>}
      </div>
    </div>
  );
}
