'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

interface BusinessRule {
  id: string;
  ruleKey: string;
  valueJson: unknown;
  effectiveFrom: string;
  notes: string | null;
  createdBy: { fullName: string } | null;
}

export default function SettingsPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editNotes, setEditNotes] = useState('');

  const rulesQuery = useQuery({
    queryKey: ['business-rules', siteId],
    queryFn: () => api.get<BusinessRule[]>(`/config/business-rules?siteId=${siteId}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ ruleKey, value, notes }: { ruleKey: string; value: unknown; notes: string }) =>
      api.patch(`/config/business-rules/${ruleKey}?siteId=${siteId}`, { value, notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-rules'] });
      setEditingRule(null);
      setEditValue('');
      setEditNotes('');
    },
  });

  function startEdit(rule: BusinessRule) {
    setEditingRule(rule.ruleKey);
    setEditValue(JSON.stringify(rule.valueJson));
    setEditNotes('');
  }

  function handleSave(ruleKey: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editValue);
    } catch {
      parsed = editValue;
    }
    updateMutation.mutate({ ruleKey, value: parsed, notes: editNotes });
  }

  function formatValue(val: unknown): string {
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  const is403 = rulesQuery.isError &&
    rulesQuery.error instanceof Error &&
    rulesQuery.error.message.includes('403');

  return (
    <div className="page-container">
      <PageHeader
        title="Settings"
        subtitle="Manage business rules and configuration"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Admin', href: '/admin' },
          { label: 'Settings' },
        ]}
      />

      {rulesQuery.isLoading && (
        <LoadingState message="Loading rules..." />
      )}

      {rulesQuery.isError && (
        is403 ? (
          <div className="card p-8 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v.01M12 9v3m0-3a9 9 0 110 18 9 9 0 010-18z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-slate-700">Permission Denied</h3>
            <p className="text-xs text-slate-400 mt-1">You do not have permission to view settings. Please sign in as a Manager.</p>
          </div>
        ) : (
          <div className="card p-6 text-center border-red-200 bg-red-50">
            <p className="text-sm text-red-700">Failed to load settings.</p>
          </div>
        )
      )}

      {rulesQuery.data && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Rule</th>
                <th>Value</th>
                <th>Notes</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {rulesQuery.data.map((rule) => (
                <tr key={rule.id} className="table-row">
                  <td>
                    <span className="font-mono font-medium text-slate-900">{rule.ruleKey}</span>
                  </td>
                  <td>
                    {editingRule === rule.ruleKey ? (
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="input-field font-mono"
                      />
                    ) : (
                      <span className="font-mono text-slate-600">
                        {formatValue(rule.valueJson)}
                      </span>
                    )}
                  </td>
                  <td className="text-xs text-slate-400">
                    {editingRule === rule.ruleKey ? (
                      <input
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Reason for change..."
                        className="input-field"
                      />
                    ) : (
                      rule.notes || '--'
                    )}
                  </td>
                  <td className="text-right">
                    {editingRule === rule.ruleKey ? (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => handleSave(rule.ruleKey)}
                          disabled={updateMutation.isPending}
                          className="btn-primary py-1.5 px-3 text-xs"
                        >
                          {updateMutation.isPending ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingRule(null)}
                          className="btn-secondary py-1.5 px-3 text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(rule)}
                        className="btn-secondary py-1.5 px-3 text-xs"
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {updateMutation.isError && (
            <div className="px-4 py-3 border-t border-red-100 bg-red-50 text-sm text-red-700">
              {updateMutation.error instanceof Error ? updateMutation.error.message : 'Update failed'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
