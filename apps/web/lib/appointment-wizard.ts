/**
 * CR-2026-106 — the staff appointment wizard's state machine (docs/121 §C5).
 *
 * Pure reducer, no React, so the reset rules are testable and explicit:
 *  - choosing a DIFFERENT customer clears the vehicle, the chosen slot and any
 *    acknowledgement (they belonged to the previous customer);
 *  - choosing a vehicle keeps the customer;
 *  - changing services or the date clears the chosen slot (its duration/day no
 *    longer apply);
 *  - every step is reachable backwards; forwards only when its inputs exist.
 *
 * The old page had a single forward path (only Time → Services could go back)
 * and an auto-advance effect that bounced a "back" straight forward again.
 */

export type WizardStep = 'customer' | 'vehicle' | 'services' | 'date' | 'time' | 'review' | 'success';

export const WIZARD_STEPS: Array<Exclude<WizardStep, 'success'>> = ['customer', 'vehicle', 'services', 'date', 'time', 'review'];

export interface WizardCustomer {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface WizardVehicle {
  id: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
}

export interface WizardSlot {
  startAt: string;
  endAt: string;
  available: boolean;
}

export interface WizardState {
  step: WizardStep;
  customer: WizardCustomer | null;
  /** Set when the customer's detail (vehicles) has been loaded at least once. */
  customerVehicles: WizardVehicle[] | null;
  vehicle: WizardVehicle | null;
  serviceCodes: string[];
  notes: string;
  /** YYYY-MM-DD site-local day the user is looking at. */
  dateKey: string | null;
  slot: WizardSlot | null;
  /** Staff acknowledged "book past capacity" after a CAPACITY_FULL warning. */
  acknowledgeCapacity: boolean;
  /** Staff chose to book after the latest-start rule (when enforced for staff). */
  overrideLatestStart: boolean;
  /** From a schedule hold deep link; converted after booking. */
  holdId: string | null;
  createdId: string | null;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  step: 'customer',
  customer: null,
  customerVehicles: null,
  vehicle: null,
  serviceCodes: [],
  notes: '',
  dateKey: null,
  slot: null,
  acknowledgeCapacity: false,
  overrideLatestStart: false,
  holdId: null,
  createdId: null,
};

export type WizardAction =
  | { type: 'PREFILL'; customerId?: string | null; vehicleId?: string | null; dateKey?: string | null; holdId?: string | null }
  | { type: 'SELECT_CUSTOMER'; customer: WizardCustomer }
  | { type: 'CLEAR_CUSTOMER' }
  | { type: 'CUSTOMER_DETAIL_LOADED'; customer: Partial<WizardCustomer> & { id: string }; vehicles: WizardVehicle[]; preferredVehicleId?: string | null }
  | { type: 'SELECT_VEHICLE'; vehicle: WizardVehicle }
  | { type: 'CLEAR_VEHICLE' }
  | { type: 'TOGGLE_SERVICE'; code: string }
  | { type: 'SET_NOTES'; notes: string }
  | { type: 'SET_DATE'; dateKey: string }
  | { type: 'SELECT_SLOT'; slot: WizardSlot }
  | { type: 'CLEAR_SLOT' }
  | { type: 'ACKNOWLEDGE_CAPACITY'; value: boolean }
  | { type: 'OVERRIDE_LATEST_START'; value: boolean }
  | { type: 'GO_TO'; step: Exclude<WizardStep, 'success'> }
  | { type: 'NEXT' }
  | { type: 'CREATED'; id: string }
  | { type: 'RESET' };

/** Can the user ENTER this step with what they have? (Backwards is always allowed.) */
export function canEnter(state: WizardState, step: Exclude<WizardStep, 'success'>): boolean {
  switch (step) {
    case 'customer':
      return true;
    case 'vehicle':
      return !!state.customer;
    case 'services':
      return !!state.customer && !!state.vehicle;
    case 'date':
      return !!state.customer && !!state.vehicle && state.serviceCodes.length > 0;
    case 'time':
      return canEnter(state, 'date') && !!state.dateKey;
    case 'review':
      return canEnter(state, 'time') && !!state.slot;
  }
}

/** The step the wizard should be on given what is filled in (used after resets). */
export function firstIncompleteStep(state: WizardState): Exclude<WizardStep, 'success'> {
  if (!state.customer) return 'customer';
  if (!state.vehicle) return 'vehicle';
  if (state.serviceCodes.length === 0) return 'services';
  if (!state.dateKey) return 'date';
  if (!state.slot) return 'time';
  return 'review';
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'PREFILL': {
      const next: WizardState = { ...state };
      if (action.customerId) {
        next.customer = { id: action.customerId, customerNumber: '', firstName: '', lastName: '', phone: '' };
        next.step = 'vehicle';
      }
      if (action.dateKey) next.dateKey = action.dateKey;
      if (action.holdId) next.holdId = action.holdId;
      // A vehicle deep link is honoured once the customer's vehicles load (see CUSTOMER_DETAIL_LOADED).
      return action.vehicleId ? { ...next, vehicle: { id: action.vehicleId, plateNumber: '', make: null, model: null, modelYear: null } } : next;
    }

    case 'SELECT_CUSTOMER': {
      if (state.customer?.id === action.customer.id) {
        return { ...state, customer: action.customer, step: 'vehicle' };
      }
      // A different person: everything that belonged to the previous customer goes.
      return {
        ...state,
        customer: action.customer,
        customerVehicles: null,
        vehicle: null,
        slot: null,
        acknowledgeCapacity: false,
        overrideLatestStart: false,
        step: 'vehicle',
      };
    }

    case 'CLEAR_CUSTOMER':
      return { ...state, customer: null, customerVehicles: null, vehicle: null, slot: null, acknowledgeCapacity: false, overrideLatestStart: false, step: 'customer' };

    case 'CUSTOMER_DETAIL_LOADED': {
      if (!state.customer || state.customer.id !== action.customer.id) return state;
      const customer: WizardCustomer = {
        id: state.customer.id,
        customerNumber: action.customer.customerNumber ?? state.customer.customerNumber,
        firstName: action.customer.firstName ?? state.customer.firstName,
        lastName: action.customer.lastName ?? state.customer.lastName,
        phone: action.customer.phone ?? state.customer.phone,
      };
      let vehicle = state.vehicle;
      // Resolve a deep-linked/placeholder vehicle to the loaded row; drop it if it is not theirs.
      if (vehicle) {
        vehicle = action.vehicles.find((v) => v.id === vehicle!.id) ?? null;
      }
      // Auto-select ONLY when the user is on the vehicle step with nothing chosen:
      // a single vehicle, or the preferred one from the deep link.
      if (!vehicle && state.step === 'vehicle') {
        const preferred = action.preferredVehicleId ? action.vehicles.find((v) => v.id === action.preferredVehicleId) : undefined;
        vehicle = preferred ?? (action.vehicles.length === 1 ? action.vehicles[0] : null);
      }
      const step = state.step === 'vehicle' && vehicle ? 'services' : state.step;
      return { ...state, customer, customerVehicles: action.vehicles, vehicle, step };
    }

    case 'SELECT_VEHICLE': {
      const changed = state.vehicle?.id !== action.vehicle.id;
      return { ...state, vehicle: action.vehicle, slot: changed ? null : state.slot, step: 'services' };
    }

    case 'CLEAR_VEHICLE':
      return { ...state, vehicle: null, slot: null, step: 'vehicle' };

    case 'TOGGLE_SERVICE': {
      const on = state.serviceCodes.includes(action.code);
      const serviceCodes = on ? state.serviceCodes.filter((c) => c !== action.code) : [...state.serviceCodes, action.code];
      // Duration may change → the chosen slot no longer applies.
      return { ...state, serviceCodes, slot: null, acknowledgeCapacity: false };
    }

    case 'SET_NOTES':
      return { ...state, notes: action.notes };

    case 'SET_DATE':
      return state.dateKey === action.dateKey ? { ...state, step: 'time' } : { ...state, dateKey: action.dateKey, slot: null, acknowledgeCapacity: false, overrideLatestStart: false, step: 'time' };

    case 'SELECT_SLOT':
      return { ...state, slot: action.slot, acknowledgeCapacity: false, step: 'review' };

    case 'CLEAR_SLOT':
      return { ...state, slot: null, acknowledgeCapacity: false, step: 'time' };

    case 'ACKNOWLEDGE_CAPACITY':
      return { ...state, acknowledgeCapacity: action.value };

    case 'OVERRIDE_LATEST_START':
      return { ...state, overrideLatestStart: action.value };

    case 'GO_TO': {
      const current = WIZARD_STEPS.indexOf(state.step as Exclude<WizardStep, 'success'>);
      const target = WIZARD_STEPS.indexOf(action.step);
      if (target <= current) return { ...state, step: action.step };
      return canEnter(state, action.step) ? { ...state, step: action.step } : state;
    }

    case 'NEXT': {
      const idx = WIZARD_STEPS.indexOf(state.step as Exclude<WizardStep, 'success'>);
      const next = WIZARD_STEPS[idx + 1];
      if (!next) return state;
      return canEnter(state, next) ? { ...state, step: next } : state;
    }

    case 'CREATED':
      return { ...state, createdId: action.id, step: 'success' };

    case 'RESET':
      return { ...INITIAL_WIZARD_STATE };

    default:
      return state;
  }
}

/** Human label per step, used by the indicator. */
export const WIZARD_STEP_LABELS: Record<Exclude<WizardStep, 'success'>, string> = {
  customer: 'Customer',
  vehicle: 'Vehicle',
  services: 'Service request',
  date: 'Date',
  time: 'Available time',
  review: 'Review',
};
