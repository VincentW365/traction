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

// CR-2026-099 — every key listed here materially controls runtime behaviour.
// Decorative settings were removed from the UI outright (HIDDEN_RULE_KEYS):
// a manager must never tune a knob connected to nothing.
const RULE_CATEGORIES: Record<string, { label: string; keys: string[] }> = {
  operating: {
    label: 'Operating Hours',
    keys: ['operating_hours'],
  },
  queue: {
    // Read by the priority engine on every recompute (scheduling.service).
    label: 'Queue Priority',
    keys: ['protected_window_early_min', 'protected_window_late_min', 'missed_threshold_min', 'lateness_penalty_per_min', 'wait_time_bonus_per_min', 'wait_time_bonus_cap_min', 'fairness_threshold_min'],
  },
  weights: {
    label: 'Priority Weights',
    keys: ['base_weight_APPT_PROTECTED', 'base_weight_APPT_LATE_SOFT', 'base_weight_WALKIN_STANDARD', 'base_weight_WALKIN_FASTTRACK'],
  },
  maintenance: {
    label: 'Maintenance',
    keys: ['default_oil_interval_miles', 'default_oil_interval_months', 'oil_brand_options', 'oil_grade_presets', 'reminder_lead_days', 'reminder_mileage_threshold', 'reminder_eligible_service_types', 'maintenance_reminder_enabled'],
  },
  appointments: {
    label: 'Appointments',
    keys: ['appointment_reminder_enabled', 'appointment_reminder_hours'],
  },
  operations: {
    label: 'Operations',
    keys: ['display_board_enabled', 'display_board_token'],
  },
  // CR-2026-105 — read by the ETA model on every recompute and (capacity keys)
  // by self-service booking. Management's 80-minute standard lives here.
  bookingEta: {
    label: 'Booking & ETA',
    keys: [
      'default_appointment_duration_minutes',
      'booking_capacity_mode',
      'booking_max_concurrent_appointments',
      'booking_capacity_resource_categories',
      'eta_transition_overhead_minutes',
      'eta_min_remaining_minutes',
      'eta_qc_minutes',
      'eta_rework_factor',
      'eta_at_risk_margin_minutes',
      'eta_delayed_grace_minutes',
      'eta_range_base_minutes',
      'eta_range_per_position_minutes',
      'eta_range_max_minutes',
      'eta_range_point_threshold_minutes',
      'overdue_job_minutes',
      'overdue_job_critical_minutes',
      // CR-2026-105c — public self-service booking.
      'booking_enabled',
      'appointment_duration_source',
      'booking_slot_interval_minutes',
      'booking_min_notice_minutes',
      'booking_advance_window_days',
      'booking_same_day_allowed',
      'booking_closed_dates',
      'booking_excluded_service_codes',
      'booking_cancel_cutoff_hours',
      'booking_reschedule_cutoff_hours',
      'booking_max_reschedules',
      'booking_manage_token_days_after',
      'booking_arrival_instructions',
      'booking_rate_limit_per_10_min',
      'staff_capacity_warning_enabled',
      'customer_booking_latest_start',
      'staff_latest_start_enforced',
      'booking_share_message_template',
      'appointment_auto_missed_enabled',
    ],
  },
};

// Settings that exist in the database but control nothing at runtime. Hidden
// from the UI rather than shown as decoration; the rows stay (harmless, and
// some are reserved for phases that never shipped).
const HIDDEN_RULE_KEYS = new Set([
  // CR-2026-099b — FIFO-first queue: scoring/weight knobs retired with it.
  'lateness_penalty_per_min',
  'wait_time_bonus_per_min',
  'wait_time_bonus_cap_min',
  'base_weight_APPT_PROTECTED',
  'base_weight_APPT_LATE_SOFT',
  'base_weight_WALKIN_STANDARD',
  'base_weight_WALKIN_FASTTRACK',
  'quick_service_bonus',
  'batching_bonus', // Phase-1 disabled
  'max_protected_delay_min', // base weights already guarantee protection
  'blocked_return_policy', // behaviour is always original-position
  'reservation_activation_min', // bay reservation feature never shipped
  'reservation_expiry_min',
  'eta_band_narrow_min', // ETA bands never shipped
  'eta_band_wide_min',
  'notification_provider_sms', // providers are deployment config (env), not a setting
  'notification_provider_email',
  'completion_requires_front_desk_action', // never wired
  'overflow_mechanic_required', // never wired
  'light_slot_mechanic_required', // never wired
]);

function categorizeRule(ruleKey: string): string {
  for (const [cat, def] of Object.entries(RULE_CATEGORIES)) {
    if (def.keys.includes(ruleKey)) return cat;
  }
  return 'other';
}

export default function SettingsPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [activeTab, setActiveTab] = useState('all');

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
          // CR-2026-084 — /admin has no page; every other admin screen uses a
          // label-only crumb here. This one linked to a 404.
          { label: 'Admin' },
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
        <>
          {/* Category Tabs */}
          <div className="flex gap-0 border-b border-slate-200 mb-5 overflow-x-auto">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider border-b-2 transition-colors whitespace-nowrap ${activeTab === 'all' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >All Rules</button>
            {Object.entries(RULE_CATEGORIES).map(([key, def]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider border-b-2 transition-colors whitespace-nowrap ${activeTab === key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
              >{def.label}</button>
            ))}
          </div>
        </>
      )}

      {rulesQuery.data && (() => {
        const filteredRules = activeTab === 'all'
          ? rulesQuery.data
          : activeTab === 'other'
            ? rulesQuery.data.filter((r) => categorizeRule(r.ruleKey) === 'other')
            : rulesQuery.data.filter((r) => RULE_CATEGORIES[activeTab]?.keys.includes(r.ruleKey));
        return filteredRules;
      })().length > 0 && (
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
              {(activeTab === 'all'
                ? rulesQuery.data!
                : rulesQuery.data!.filter((r) =>
                    activeTab === 'other'
                      ? categorizeRule(r.ruleKey) === 'other'
                      : RULE_CATEGORIES[activeTab]?.keys.includes(r.ruleKey)
                  )
              ).map((rule) => (
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
