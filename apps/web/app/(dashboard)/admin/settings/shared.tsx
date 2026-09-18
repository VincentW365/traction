'use client';

/**
 * CR-2026-109 — pieces shared by the Settings landing page and the category
 * pages. Kept out of both so the two cannot drift on what a rule row looks like.
 */

export interface BusinessRule {
  id: string;
  ruleKey: string;
  valueJson: unknown;
  effectiveFrom: string;
  notes: string | null;
  createdBy: { fullName: string } | null;
}

/** The live value of a rule, or undefined when the deployment has no row. */
export function ruleValue(rules: BusinessRule[], key: string): unknown {
  return rules.find((r) => r.ruleKey === key)?.valueJson;
}

export function ruleRow(rules: BusinessRule[], key: string): BusinessRule | undefined {
  return rules.find((r) => r.ruleKey === key);
}

/**
 * §13 — who last changed this, from the audit trail the platform already keeps.
 * `BusinessRuleConfig` is versioned: the active row carries the user who created
 * it and when it took effect, so this costs nothing extra.
 */
export function lastChangedOf(rule: BusinessRule | undefined): { by: string; at: string } | null {
  if (!rule?.createdBy?.fullName) return null;
  const at = new Date(rule.effectiveFrom);
  if (Number.isNaN(at.getTime())) return null;
  return {
    by: rule.createdBy.fullName,
    at: at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
  };
}

export function PermissionDenied() {
  return (
    <div className="surface p-10 text-center">
      <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mb-3">
        <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v.01M12 9v3m0-3a9 9 0 110 18 9 9 0 010-18z" />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-slate-900">You do not have access to Settings</h2>
      <p className="text-sm text-slate-500 mt-1">Sign in as a Manager to view and change configuration.</p>
    </div>
  );
}
