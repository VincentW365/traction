'use client';

interface StatCardProps {
  value: string | number;
  label: string;
  color?: 'blue' | 'green' | 'amber' | 'red' | 'slate';
  icon?: React.ReactNode;
}

const colorMap = {
  blue: 'border-l-blue-500 bg-blue-50/30',
  green: 'border-l-emerald-500 bg-emerald-50/30',
  amber: 'border-l-amber-500 bg-amber-50/30',
  red: 'border-l-red-500 bg-red-50/30',
  slate: 'border-l-slate-400 bg-slate-50/30',
};

const valueColorMap = {
  blue: 'text-blue-700',
  green: 'text-emerald-700',
  amber: 'text-amber-700',
  red: 'text-red-700',
  slate: 'text-slate-700',
};

export function StatCard({ value, label, color = 'slate', icon }: StatCardProps) {
  return (
    <div className={`rounded-lg border border-slate-200 border-l-4 p-4 ${colorMap[color]}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-2xl font-bold ${valueColorMap[color]}`}>{value}</div>
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide mt-0.5">{label}</div>
        </div>
        {icon && <div className="text-slate-300">{icon}</div>}
      </div>
    </div>
  );
}
