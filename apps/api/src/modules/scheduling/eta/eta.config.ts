/**
 * CR-2026-105b — ETA read-model configuration.
 *
 * Every number the ETA model uses is a BusinessRuleConfig key (CLAUDE.md §10: no
 * hidden magic constants). The defaults below are what the seed writes and what
 * applies when a row is absent; a manager edits them under Settings → Booking & ETA.
 *
 * The workshop-capacity keys are deliberately SHARED with the self-service booking
 * engine (CR-2026-105c): the number of concurrent service positions is one
 * business fact, whether it is used to offer a slot or to project a completion.
 */

export const ETA_RULE_KEYS = [
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
] as const;

export type EtaRuleKey = (typeof ETA_RULE_KEYS)[number];

/** Inputs the pure model needs to project start/completion times. */
export interface EtaModelConfig {
  /** Concurrent service positions ("tracks") at the site. */
  capacity: number;
  /** Minutes between one job finishing on a track and the next starting. */
  transitionOverheadMinutes: number;
  /** Floor for the remaining minutes of an in-progress job. */
  minRemainingMinutes: number;
  /** Allowance for a job sitting in quality control. */
  qcMinutes: number;
  /** Share of the planned minutes assumed to remain after a rework is opened. */
  reworkFactor: number;
  /** Planned minutes when nothing better is known (management's 80). */
  defaultDurationMinutes: number;
}

/** Inputs the read-side presentation needs to classify and widen an estimate. */
export interface EtaPresentationConfig {
  atRiskMarginMinutes: number;
  delayedGraceMinutes: number;
  rangeBaseMinutes: number;
  rangePerPositionMinutes: number;
  rangeMaxMinutes: number;
  rangePointThresholdMinutes: number;
}

export interface EtaRuleValues extends EtaModelConfig, EtaPresentationConfig {
  capacityMode: 'FIXED' | 'RESOURCES';
  capacityResourceCategories: string[];
  overdueJobMinutes: number;
  overdueJobCriticalMinutes: number;
}

export const ETA_DEFAULTS: EtaRuleValues = {
  capacity: 2,
  capacityMode: 'FIXED',
  capacityResourceCategories: ['BAY', 'OVERFLOW'],
  transitionOverheadMinutes: 5,
  minRemainingMinutes: 5,
  qcMinutes: 10,
  reworkFactor: 0.5,
  defaultDurationMinutes: 80,
  atRiskMarginMinutes: 15,
  delayedGraceMinutes: 0,
  rangeBaseMinutes: 10,
  rangePerPositionMinutes: 5,
  rangeMaxMinutes: 45,
  rangePointThresholdMinutes: 10,
  overdueJobMinutes: 120,
  overdueJobCriticalMinutes: 240,
};

export const ETA_PRESENTATION_DEFAULTS: EtaPresentationConfig = {
  atRiskMarginMinutes: ETA_DEFAULTS.atRiskMarginMinutes,
  delayedGraceMinutes: ETA_DEFAULTS.delayedGraceMinutes,
  rangeBaseMinutes: ETA_DEFAULTS.rangeBaseMinutes,
  rangePerPositionMinutes: ETA_DEFAULTS.rangePerPositionMinutes,
  rangeMaxMinutes: ETA_DEFAULTS.rangeMaxMinutes,
  rangePointThresholdMinutes: ETA_DEFAULTS.rangePointThresholdMinutes,
};

export interface RuleRow {
  ruleKey: string;
  valueJson: unknown;
  siteId?: string | null;
}

function num(value: unknown, fallback: number, min = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Pure: fold rule rows into a typed config. A site-scoped row wins over a global
 * one for the same key (rows are applied global-first, site-last). Invalid values
 * fall back to the documented default rather than poisoning the model.
 */
export function etaConfigFromRules(rows: RuleRow[]): EtaRuleValues {
  const ordered = [...rows].sort((a, b) => (a.siteId ? 1 : 0) - (b.siteId ? 1 : 0));
  const cfg: EtaRuleValues = { ...ETA_DEFAULTS, capacityResourceCategories: [...ETA_DEFAULTS.capacityResourceCategories] };
  for (const r of ordered) {
    const v = r.valueJson;
    switch (r.ruleKey as EtaRuleKey) {
      case 'default_appointment_duration_minutes':
        cfg.defaultDurationMinutes = num(v, cfg.defaultDurationMinutes, 1);
        break;
      case 'booking_capacity_mode':
        if (v === 'FIXED' || v === 'RESOURCES') cfg.capacityMode = v;
        break;
      case 'booking_max_concurrent_appointments':
        cfg.capacity = num(v, cfg.capacity, 1);
        break;
      case 'booking_capacity_resource_categories':
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) cfg.capacityResourceCategories = v as string[];
        break;
      case 'eta_transition_overhead_minutes':
        cfg.transitionOverheadMinutes = num(v, cfg.transitionOverheadMinutes);
        break;
      case 'eta_min_remaining_minutes':
        cfg.minRemainingMinutes = num(v, cfg.minRemainingMinutes);
        break;
      case 'eta_qc_minutes':
        cfg.qcMinutes = num(v, cfg.qcMinutes);
        break;
      case 'eta_rework_factor':
        cfg.reworkFactor = typeof v === 'number' && v > 0 && v <= 1 ? v : cfg.reworkFactor;
        break;
      case 'eta_at_risk_margin_minutes':
        cfg.atRiskMarginMinutes = num(v, cfg.atRiskMarginMinutes);
        break;
      case 'eta_delayed_grace_minutes':
        cfg.delayedGraceMinutes = num(v, cfg.delayedGraceMinutes);
        break;
      case 'eta_range_base_minutes':
        cfg.rangeBaseMinutes = num(v, cfg.rangeBaseMinutes);
        break;
      case 'eta_range_per_position_minutes':
        cfg.rangePerPositionMinutes = num(v, cfg.rangePerPositionMinutes);
        break;
      case 'eta_range_max_minutes':
        cfg.rangeMaxMinutes = num(v, cfg.rangeMaxMinutes);
        break;
      case 'eta_range_point_threshold_minutes':
        cfg.rangePointThresholdMinutes = num(v, cfg.rangePointThresholdMinutes);
        break;
      case 'overdue_job_minutes':
        cfg.overdueJobMinutes = num(v, cfg.overdueJobMinutes, 1);
        break;
      case 'overdue_job_critical_minutes':
        cfg.overdueJobCriticalMinutes = num(v, cfg.overdueJobCriticalMinutes, 1);
        break;
      default:
        break;
    }
  }
  return cfg;
}
