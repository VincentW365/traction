/**
 * CR-2026-109 — what every setting is CALLED, in the manager's words.
 *
 * The Settings screen used to render `BusinessRuleConfig` rows directly: the
 * database key as the label, the raw JSON as the value. That is a developer's
 * view of a manager's job. Nothing about the stored data changes here — this file
 * only decides how a key is presented, which control edits it, and where it sits.
 *
 * Deliberately pure data and pure functions, with no React in it, so the wording
 * and the grouping can be tested without rendering anything.
 *
 * THE SAFETY RULE: a key that is not listed here is still shown, under "Other
 * settings", with its raw value. Presentation work must never make a live
 * business rule unreachable — if a rule stops appearing, somebody loses the
 * ability to change how the shop runs.
 */

export type ControlKind = 'toggle' | 'number' | 'time' | 'choice' | 'text' | 'textarea' | 'list' | 'json';

export interface SettingChoice {
  value: string;
  label: string;
  help?: string;
}

export interface SettingDef {
  key: string;
  /** What a manager calls it. */
  label: string;
  /** One sentence, plain language, describing what changing it does. */
  help: string;
  control: ControlKind;
  /** Shown beside a number so the unit is never guessed. */
  unit?: string;
  choices?: SettingChoice[];
  min?: number;
  max?: number;
  /**
   * Settings for troubleshooting or exceptional operations. Collapsed by
   * default: a manager should first see the things they actually decide about.
   */
  advanced?: boolean;
  /**
   * Changing this materially changes what customers experience. Shown with the
   * consequence spelled out, so it cannot be mistaken for a routine dropdown.
   */
  impact?: string;
  /**
   * The setting only governs anything while another setting has a given value.
   * Configuration that is not in force must not look as though it is.
   */
  activeWhen?: { key: string; equals: string; inactiveNote: string };
}

export interface SettingsSectionDef {
  title: string;
  help?: string;
  settings: SettingDef[];
}

export type CategoryIcon =
  | 'calendar' | 'gauge' | 'users' | 'clipboard' | 'list' | 'bell' | 'wrench' | 'flask';

export interface SettingsCategoryDef {
  slug: string;
  title: string;
  description: string;
  icon: CategoryIcon;
  sections: SettingsSectionDef[];
  /** Related tools, as secondary actions rather than navigation clutter. */
  links?: Array<{ label: string; href: string; requiresRule?: string }>;
}

// ---------------------------------------------------------------------------
// Shared choice vocabularies. The STORED values are unchanged; only the labels
// are readable (§22 — do not change the stored enum values).
// ---------------------------------------------------------------------------

const CAPACITY_MODES: SettingChoice[] = [
  {
    value: 'FIXED',
    label: 'Fixed limit',
    help: 'One number caps how many appointments can overlap, whatever the work is.',
  },
  {
    value: 'RESOURCES',
    label: 'Resource-aware',
    help: 'Availability is worked out from the bays actually configured and what each can do.',
  },
];

const DURATION_MODELS: SettingChoice[] = [
  {
    value: 'DEFAULT',
    label: 'Standard length',
    help: 'Every appointment is planned at the same standard length.',
  },
  {
    value: 'CATALOGUE',
    label: 'Per service',
    help: 'Each appointment uses the length recorded against the service.',
  },
];

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const SETTINGS_CATEGORIES: SettingsCategoryDef[] = [
  {
    slug: 'booking',
    title: 'Booking & Scheduling',
    description: 'Appointment availability, online booking, notice periods and scheduling policies.',
    icon: 'calendar',
    links: [
      { label: 'Open Booking Simulator', href: '/admin/testing/booking', requiresRule: 'booking_simulator_enabled' },
      { label: 'Manage services', href: '/admin/service-catalogue' },
    ],
    sections: [
      {
        title: 'Online booking',
        help: 'What customers can do on the public booking page.',
        settings: [
          {
            key: 'booking_enabled',
            label: 'Online Booking',
            help: 'When off, the public booking page stops accepting appointments. Staff booking is unaffected.',
            control: 'toggle',
            impact: 'Turning this off immediately stops customers booking online. Anyone with an existing appointment keeps it.',
          },
          {
            key: 'booking_enforce_online_bookable',
            label: 'Use Approved Online Service Catalogue',
            help: 'When on, customers can only book services that have been approved for online booking.',
            control: 'toggle',
            impact: 'Turning this off would offer customers every active service online, including diagnostics and repairs that need an advisor to scope.',
          },
          {
            key: 'booking_same_day_allowed',
            label: 'Allow Same-Day Booking',
            help: 'Whether customers may book a time later today.',
            control: 'toggle',
          },
          {
            key: 'booking_min_notice_minutes',
            label: 'Minimum Booking Notice',
            help: 'How far in advance a customer must book. Times sooner than this are not offered.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'booking_advance_window_days',
            label: 'How Far Ahead Customers Can Book',
            help: 'The furthest date the booking page will offer.',
            control: 'number',
            unit: 'days',
            min: 1,
          },
          {
            key: 'customer_booking_latest_start',
            label: 'Latest Customer Appointment Start',
            help: 'No start time after this is offered to customers. Leave empty for no cutoff.',
            control: 'time',
          },
          {
            key: 'staff_latest_start_enforced',
            label: 'Apply the Latest Start to Staff Too',
            help: 'When on, front-desk bookings are held to the same cutoff. Staff can still override it, and the override is recorded.',
            control: 'toggle',
          },
          {
            key: 'booking_closed_dates',
            label: 'Closed Dates',
            help: 'Dates the booking page offers nothing, on top of normal opening hours. One date per line, as YYYY-MM-DD.',
            control: 'list',
          },
          {
            key: 'booking_excluded_service_codes',
            label: 'Services Never Offered Online',
            help: 'Service codes kept off the booking page regardless of any other setting. One per line.',
            control: 'list',
            advanced: true,
          },
          {
            key: 'booking_rate_limit_per_10_min',
            label: 'Booking Rate Limit',
            help: 'How many booking attempts one visitor may make in ten minutes. Guards against automated abuse.',
            control: 'number',
            unit: 'attempts',
            min: 1,
            advanced: true,
          },
        ],
      },
      {
        title: 'Managing an appointment',
        help: 'What a customer can change after booking, using the link in their confirmation.',
        settings: [
          {
            key: 'booking_cancel_cutoff_hours',
            label: 'Cancellation Cutoff',
            help: 'How close to the appointment a customer may still cancel online.',
            control: 'number',
            unit: 'hours',
            min: 0,
          },
          {
            key: 'booking_reschedule_cutoff_hours',
            label: 'Reschedule Cutoff',
            help: 'How close to the appointment a customer may still move it online.',
            control: 'number',
            unit: 'hours',
            min: 0,
          },
          {
            key: 'booking_max_reschedules',
            label: 'Maximum Reschedules',
            help: 'How many times one appointment may be moved by the customer.',
            control: 'number',
            unit: 'times',
            min: 0,
          },
          {
            key: 'booking_manage_token_days_after',
            label: 'Manage Link Expiry',
            help: 'How long the link in the confirmation keeps working after the appointment date.',
            control: 'number',
            unit: 'days',
            min: 1,
          },
          {
            key: 'appointment_auto_missed_enabled',
            label: 'Automatically Mark Appointments Missed',
            help: 'When on, an appointment nobody arrived for is marked missed without anyone touching it.',
            control: 'toggle',
            advanced: true,
            impact: 'Automatic marking affects customer records and reporting. Leave off unless the arrival process is reliably recorded.',
          },
        ],
      },
      {
        title: 'Scheduling model',
        help: 'How the system decides whether a time can be offered at all.',
        settings: [
          {
            key: 'booking_capacity_mode',
            label: 'Capacity Model',
            help: 'How available time is worked out.',
            control: 'choice',
            choices: CAPACITY_MODES,
            impact:
              'Switching to Resource-aware means customer availability is calculated from the configured workshop resources instead of the fixed limit. It cannot be switched on until every bookable service has a bay that can do it.',
          },
          {
            key: 'booking_max_concurrent_appointments',
            label: 'Concurrent Appointment Limit',
            help: 'The greatest number of appointments allowed to overlap at any moment.',
            control: 'number',
            unit: 'appointments',
            min: 1,
            impact: 'This is the main control on how much work is accepted per day. Raise it only when the workshop can genuinely absorb more.',
            activeWhen: {
              key: 'booking_capacity_mode',
              equals: 'FIXED',
              inactiveNote: 'Not in use — availability is currently worked out from workshop resources.',
            },
          },
          {
            key: 'appointment_duration_source',
            label: 'Appointment Duration Model',
            help: 'Whether every appointment is planned at one standard length, or at the length recorded for the service.',
            control: 'choice',
            choices: DURATION_MODELS,
            impact:
              'Per-service lengths fit more work into a day. Review the impact analysis before switching — shorter jobs put more bookings through the same bays.',
          },
          {
            key: 'default_appointment_duration_minutes',
            label: 'Standard Appointment Length',
            help: 'The length planned for every appointment while the standard model is in use.',
            control: 'number',
            unit: 'minutes',
            min: 5,
            activeWhen: {
              key: 'appointment_duration_source',
              equals: 'DEFAULT',
              inactiveNote: 'Not in use — appointment lengths currently come from each service.',
            },
          },
          {
            key: 'booking_slot_interval_minutes',
            label: 'Slot Interval',
            help: 'How far apart the offered start times are.',
            control: 'number',
            unit: 'minutes',
            min: 5,
          },
          {
            key: 'staff_capacity_warning_enabled',
            label: 'Warn Staff When Fully Booked',
            help: 'Shows front-desk staff a warning when a slot is already full. It warns; it never blocks.',
            control: 'toggle',
            advanced: true,
          },
          {
            key: 'booking_capacity_resource_categories',
            label: 'Resource Types That Count as Capacity',
            help: 'Which kinds of resource are counted when capacity is worked out from the workshop. One per line.',
            control: 'list',
            advanced: true,
          },
        ],
      },
      {
        // CR-2026-116 — the switch lives here, in the category the tool belongs
        // to, and NEVER behind the tool it controls. A setting reachable only
        // through the thing it can hide would be a one-way door.
        title: 'Testing tools',
        help: 'Tools for checking how booking behaves. They change nothing customers see.',
        settings: [
          {
            key: 'booking_simulator_enabled',
            label: 'Booking Simulator',
            help: 'A Manager-only tool that explains why a time is or is not offered, and can make a test booking that is kept separate from real ones.',
            control: 'toggle',
            impact:
              'Turning this off removes the Booking Simulator from Setup and stops new test bookings being started. Nothing a customer sees changes, and test records already created are kept.',
          },
        ],
      },
    ],
  },

  {
    slug: 'capacity',
    title: 'Capacity & Resources',
    description: 'Workshop capacity, resource-aware scheduling and operational availability.',
    icon: 'gauge',
    links: [
      { label: 'Manage Resources & Bays', href: '/admin/resources' },
      { label: 'Confirm Work Positions', href: '/admin/resources/reconciliation' },
    ],
    // No settings of its own: this category is the readiness view plus the two
    // resource screens. Its one configuration value lives with the scheduling
    // model it feeds.
    sections: [],
  },

  {
    slug: 'customer',
    title: 'Customer Experience',
    description: 'Customer booking wording, arrival instructions and how estimated times are presented.',
    icon: 'users',
    sections: [
      {
        title: 'What customers are told',
        settings: [
          {
            key: 'booking_arrival_instructions',
            label: 'Arrival Instructions',
            help: 'Shown on the confirmation and the manage page. Tell the customer what to bring and where to go.',
            control: 'textarea',
          },
          {
            key: 'booking_share_message_template',
            label: 'Booking Link Message',
            help: 'The message staff send with a booking link. {bookingUrl} and {siteName} are replaced automatically.',
            control: 'textarea',
          },
        ],
      },
      {
        title: 'Estimated times',
        help: 'An estimate is a promise a customer will remember, so it is deliberately shown as a range rather than a single time.',
        settings: [
          {
            key: 'eta_range_base_minutes',
            label: 'Estimate Range — Starting Width',
            help: 'How wide the estimate is before anything else widens it.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'eta_range_per_position_minutes',
            label: 'Estimate Range — Added per Vehicle Ahead',
            help: 'The estimate widens by this much for each vehicle in front.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'eta_range_max_minutes',
            label: 'Estimate Range — Widest',
            help: 'The estimate never gets wider than this, however busy it is.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'eta_range_point_threshold_minutes',
            label: 'Show a Single Time Below',
            help: 'When the range is narrower than this, one time is shown instead of a range.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'eta_at_risk_margin_minutes',
            label: 'Flag as At Risk',
            help: 'How far past the promised time a job must be projected before it is flagged.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'eta_delayed_grace_minutes',
            label: 'Grace Before Showing Delayed',
            help: 'How long past the promised time before a job is shown as delayed.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
        ],
      },
    ],
  },

  {
    slug: 'queue',
    title: 'Queue & Arrival Rules',
    description: 'Appointment protection windows, walk-ins, late arrivals and missed appointments.',
    icon: 'list',
    sections: [
      {
        title: 'Appointment protection',
        help: 'The queue runs in arrival order. These are the only rules that let an appointment go ahead of someone already waiting.',
        settings: [
          {
            key: 'protected_window_early_min',
            label: 'Early Arrival Window',
            help: 'How early an appointment customer may arrive and still keep their protected place.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'protected_window_late_min',
            label: 'Late Arrival Grace',
            help: 'How late an appointment customer may arrive and still keep their protected place.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'missed_threshold_min',
            label: 'Treat as Missed After',
            help: 'How long past the appointment time before it counts as missed.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'fairness_threshold_min',
            label: 'Long Wait Escalation',
            help: 'After waiting this long, a customer is escalated so nobody is left behind indefinitely.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
        ],
      },
      {
        title: 'Same-day arrivals',
        settings: [
          {
            key: 'same_day_appointment_cutoff_time',
            label: 'Same-Day Appointment Cutoff',
            help: 'After this time, a same-day appointment needs a manager to approve it.',
            control: 'time',
          },
          {
            key: 'manager_override_required_after_cutoff',
            label: 'Require Manager Approval After Cutoff',
            help: 'When on, booking past the same-day cutoff needs an explicit, recorded manager decision.',
            control: 'toggle',
          },
          {
            key: 'same_day_walkin_policy',
            label: 'Walk-In Policy',
            help: 'How walk-in customers are handled alongside booked appointments.',
            control: 'choice',
            choices: [
              { value: 'ALLOW', label: 'Accept walk-ins', help: 'Walk-ins join the queue in arrival order.' },
              { value: 'DISCOURAGE', label: 'Discourage walk-ins', help: 'Staff are prompted to book the customer instead.' },
              { value: 'BLOCK', label: 'No walk-ins', help: 'Walk-ins are not accepted.' },
            ],
          },
        ],
      },
    ],
  },

  {
    slug: 'notifications',
    title: 'Notifications',
    description: 'Customer reminders, follow-ups and the timing of automated messages.',
    icon: 'bell',
    links: [{ label: 'Message templates', href: '/admin/notifications' }],
    sections: [
      {
        title: 'Appointment reminders',
        settings: [
          {
            key: 'appointment_reminder_enabled',
            label: 'Appointment Reminders',
            help: 'Send customers a reminder before their appointment.',
            control: 'toggle',
          },
          {
            key: 'appointment_reminder_hours',
            label: 'Send Reminder',
            help: 'How long before the appointment the reminder goes out.',
            control: 'number',
            unit: 'hours before',
            min: 1,
          },
        ],
      },
      {
        title: 'Customer consent',
        help: 'Which customer emails need the customer to have opted in.',
        settings: [
          {
            key: 'notification_purposes_requiring_consent',
            label: 'Emails That Need Opt-In',
            help:
              'Optional outreach (MARKETING) normally needs the customer to have agreed. Emails about a booking or a job in progress (TRANSACTIONAL) and reminders about an appointment they made (REMINDER) are sent to any customer with an email address. One purpose per line.',
            control: 'list',
            advanced: true,
          },
        ],
      },
      {
        title: 'Service due reminders',
        settings: [
          {
            key: 'maintenance_reminder_enabled',
            label: 'Service Due Reminders',
            help: 'Contact customers when a vehicle is approaching its next service.',
            control: 'toggle',
          },
          {
            key: 'reminder_lead_days',
            label: 'Remind This Far Ahead',
            help: 'How many days before the service is due to make contact.',
            control: 'number',
            unit: 'days',
            min: 1,
          },
          {
            key: 'reminder_mileage_threshold',
            label: 'Remind Within This Mileage',
            help: 'How close to the due mileage a vehicle must be before a reminder is sent.',
            control: 'number',
            unit: 'miles',
            min: 0,
          },
          {
            key: 'reminder_eligible_service_types',
            label: 'Services That Trigger Reminders',
            help: 'Service codes a due-reminder may be raised for. One per line.',
            control: 'list',
            advanced: true,
          },
        ],
      },
      {
        title: 'Daily follow-ups',
        help: 'Prompts for the front desk to chase progress during the day.',
        settings: [
          {
            key: 'pre_noon_followup_enabled',
            label: 'Morning Follow-Up',
            help: 'Raise a mid-morning prompt to review jobs in progress.',
            control: 'toggle',
          },
          { key: 'pre_noon_followup_time', label: 'Morning Follow-Up Time', help: 'When the morning prompt is raised.', control: 'time' },
          {
            key: 'midday_followup_enabled',
            label: 'Midday Follow-Up',
            help: 'Raise a midday prompt to review jobs in progress.',
            control: 'toggle',
          },
          { key: 'midday_followup_run_time', label: 'Midday Follow-Up Time', help: 'When the midday prompt is raised.', control: 'time' },
        ],
      },
    ],
  },

  {
    slug: 'workshop',
    title: 'Workshop Operations',
    description: 'Opening hours, the display board, job timing thresholds and servicing defaults.',
    icon: 'wrench',
    sections: [
      {
        title: 'Opening hours',
        settings: [
          {
            key: 'operating_hours',
            label: 'Opening Hours',
            help: 'When the Service Centre is open. Everything the booking page offers is bounded by these hours.',
            control: 'json',
          },
        ],
      },
      {
        title: 'Job timing',
        help: 'When a job in progress is flagged for attention.',
        settings: [
          {
            key: 'overdue_job_minutes',
            label: 'Flag Job as Overdue',
            help: 'How long past its estimate a job runs before it is flagged.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
          {
            key: 'overdue_job_critical_minutes',
            label: 'Escalate Overdue Job',
            help: 'How long past its estimate before a job is escalated as critical.',
            control: 'number',
            unit: 'minutes',
            min: 0,
          },
        ],
      },
      {
        title: 'Customer display board',
        settings: [
          {
            key: 'display_board_enabled',
            label: 'Waiting Area Display',
            help: 'Shows the public queue board in the waiting area.',
            control: 'toggle',
          },
          {
            key: 'display_board_token',
            label: 'Display Board Access Code',
            help: 'The code in the display board address. Change it to revoke access from a screen you no longer control.',
            control: 'text',
            advanced: true,
          },
        ],
      },
      {
        title: 'Servicing defaults',
        settings: [
          {
            key: 'default_oil_interval_miles',
            label: 'Oil Change Interval — Mileage',
            help: 'Default distance between oil changes, used when a vehicle has no specific interval.',
            control: 'number',
            unit: 'miles',
            min: 1,
          },
          {
            key: 'default_oil_interval_months',
            label: 'Oil Change Interval — Time',
            help: 'Default time between oil changes, used when a vehicle has no specific interval.',
            control: 'number',
            unit: 'months',
            min: 1,
          },
          { key: 'oil_brand_options', label: 'Oil Brands', help: 'Brands offered when recording an oil change. One per line.', control: 'list', advanced: true },
          { key: 'oil_grade_presets', label: 'Oil Grades', help: 'Grades offered when recording an oil change. One per line.', control: 'list', advanced: true },
        ],
      },
      {
        title: 'Estimate model',
        help: 'Constants behind the estimated-completion calculation. Change these only with a specific reason.',
        settings: [
          { key: 'eta_transition_overhead_minutes', label: 'Changeover Allowance', help: 'Time allowed between one job finishing in a bay and the next starting.', control: 'number', unit: 'minutes', min: 0, advanced: true },
          { key: 'eta_min_remaining_minutes', label: 'Minimum Remaining Time', help: 'The least amount of time a job in progress is ever assumed to have left.', control: 'number', unit: 'minutes', min: 0, advanced: true },
          { key: 'eta_qc_minutes', label: 'Quality Check Allowance', help: 'Time allowed for a job sitting in quality control.', control: 'number', unit: 'minutes', min: 0, advanced: true },
          { key: 'eta_rework_factor', label: 'Rework Allowance', help: 'The share of the original planned time assumed to remain when a job goes back for rework.', control: 'number', unit: 'of planned time', min: 0, max: 1, advanced: true },
        ],
      },
    ],
  },
];

/**
 * Categories that are a launchpad rather than a form. They own no settings of
 * their own; putting an empty settings screen behind them would be worse than
 * sending the manager straight to the tool.
 */
export const SETTINGS_LAUNCHPADS: Array<{
  slug: string;
  title: string;
  description: string;
  icon: CategoryIcon;
  links: Array<{ label: string; href: string; help: string; requiresRule?: string }>;
}> = [
  {
    slug: 'services',
    title: 'Services & Catalogue',
    description: 'Which services customers can book online, how long each takes and what they are called.',
    icon: 'clipboard',
    links: [
      { label: 'Manage service catalogue', href: '/admin/service-catalogue', help: 'Names, lengths, and which services are offered online.' },
    ],
  },
  {
    slug: 'system',
    title: 'System & Testing',
    description: 'Booking simulator, test bookings, resource reconciliation and deployment checks.',
    icon: 'flask',
    links: [
      { label: 'Booking Simulator', href: '/admin/testing/booking', help: 'Why a time is or is not offered, and a safe way to make a test booking.', requiresRule: 'booking_simulator_enabled' },
      { label: 'Confirm Work Positions', href: '/admin/resources/reconciliation', help: 'Match bays to records and say what work each can take.' },
      { label: 'Deployment', href: '/admin/deployment', help: 'Whether this installation is configured correctly.' },
      { label: 'Audit Logs', href: '/admin/audit-logs', help: 'Who changed what, and when.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookups and formatting
// ---------------------------------------------------------------------------

const BY_KEY = new Map<string, { setting: SettingDef; category: SettingsCategoryDef }>();
for (const category of SETTINGS_CATEGORIES) {
  for (const section of category.sections) {
    for (const setting of section.settings) BY_KEY.set(setting.key, { setting, category });
  }
}

export function findSetting(key: string): SettingDef | undefined {
  return BY_KEY.get(key)?.setting;
}

/**
 * CR-2026-116 — should a link to a tool be offered at all?
 *
 * A link that leads to a feature management has switched off is a dead end, so
 * it is not shown. `undefined` — no row for the rule in this deployment — counts
 * as ON: introducing a switch must never be what removes a working tool.
 *
 * Pure, and takes the lookup as an argument, so the rule can be tested without
 * a query client.
 */
export function linkIsAvailable(
  link: { requiresRule?: string },
  ruleValue: (key: string) => unknown,
): boolean {
  if (!link.requiresRule) return true;
  const value = ruleValue(link.requiresRule);
  return value === undefined ? true : value === true;
}

export function categoryFor(key: string): SettingsCategoryDef | undefined {
  return BY_KEY.get(key)?.category;
}

export function findCategory(slug: string): SettingsCategoryDef | undefined {
  return SETTINGS_CATEGORIES.find((c) => c.slug === slug);
}

/** Every key the catalogue presents in business language. */
export function catalogued(): string[] {
  return [...BY_KEY.keys()];
}

/**
 * Rules that exist but control nothing at runtime.
 *
 * Carried over unchanged from the previous screen (CR-2026-099): hidden rather
 * than shown as decoration, because a manager must never tune a knob that is
 * connected to nothing. The rows stay in the database — some are reserved for
 * phases that never shipped — they are simply not offered as controls.
 */
export const HIDDEN_RULE_KEYS = new Set([
  'lateness_penalty_per_min',
  'wait_time_bonus_per_min',
  'wait_time_bonus_cap_min',
  'base_weight_APPT_PROTECTED',
  'base_weight_APPT_LATE_SOFT',
  'base_weight_WALKIN_STANDARD',
  'base_weight_WALKIN_FASTTRACK',
  'quick_service_bonus',
  'batching_bonus',
  'max_protected_delay_min',
  'blocked_return_policy',
  'reservation_activation_min',
  'reservation_expiry_min',
  'eta_band_narrow_min',
  'eta_band_wide_min',
  'notification_provider_sms',
  'notification_provider_email',
  'completion_requires_front_desk_action',
  'overflow_mechanic_required',
  'light_slot_mechanic_required',
  // CR-2026-108 — written by the shadow validation run, not edited by hand.
  'resource_shadow_validation',
]);

/** "15:00" → "3:00 PM". Site-local wall clock; no timezone maths involved. */
export function to12Hour(hhmm: unknown): string | null {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/**
 * 120 → "2 hours". The human translation beside a number, so nobody has to do
 * the arithmetic to know whether 120 minutes is reasonable.
 */
export function humaniseMinutes(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value < 60) return null;
  const hours = value / 60;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const whole = Math.floor(hours);
  const mins = value - whole * 60;
  return `${whole} hr ${mins} min`;
}

/** 30 → "about a month", for day counts a manager reads as a period. */
export function humaniseDays(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 7) return null;
  if (value % 7 === 0 && value < 28) return `${value / 7} week${value / 7 === 1 ? '' : 's'}`;
  if (value >= 28 && value <= 31) return 'about a month';
  if (value >= 60 && value <= 62) return 'about two months';
  return null;
}

/** The label a choice value should be shown as, falling back to the raw value. */
export function choiceLabel(def: SettingDef | undefined, value: unknown): string {
  if (!def?.choices) return String(value);
  return def.choices.find((c) => c.value === value)?.label ?? String(value);
}

/** What a value reads as in the summary strip and section headers. */
export function displayValue(def: SettingDef | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (def?.control === 'time') return to12Hour(value) ?? String(value);
  if (def?.control === 'choice') return choiceLabel(def, value);
  if (Array.isArray(value)) return value.length === 0 ? 'None' : `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return 'Configured';
  if (def?.unit) return `${value} ${def.unit}`;
  return String(value);
}
