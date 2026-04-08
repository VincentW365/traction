import { describe, it, expect } from 'vitest';
import {
  derivePartsReadiness,
  isPartsReadyForDispatch,
  ServiceTypeInfo,
  PartsRequestInfo,
} from '../engine/parts-readiness.checker';

describe('derivePartsReadiness', () => {
  it('returns NOT_REQUIRED when no service needs parts and no requests exist', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: false },
      { partsPrepositionRequired: false },
    ];
    expect(derivePartsReadiness(serviceTypes, [])).toBe('NOT_REQUIRED');
  });

  it('returns UNCONFIRMED when service needs parts but no request created', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    expect(derivePartsReadiness(serviceTypes, [])).toBe('UNCONFIRMED');
  });

  it('returns READY when all critical items are fulfilled', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      {
        status: 'READY',
        items: [
          { criticalFlag: true, status: 'RECEIVED' },
          { criticalFlag: false, status: 'OPEN' },
        ],
      },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('READY');
  });

  it('returns REQUIRED_NOT_READY when critical item is still OPEN', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      {
        status: 'OPEN',
        items: [
          { criticalFlag: true, status: 'OPEN' },
        ],
      },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('REQUIRED_NOT_READY');
  });

  it('returns READY when only non-critical items are unresolved', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      {
        status: 'PARTIAL',
        items: [
          { criticalFlag: true, status: 'FULFILLED' },
          { criticalFlag: false, status: 'OPEN' },
        ],
      },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('READY');
  });

  it('returns READY when request has no critical items', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      {
        status: 'OPEN',
        items: [
          { criticalFlag: false, status: 'OPEN' },
        ],
      },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('READY');
  });

  it('ignores cancelled requests', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      {
        status: 'CANCELLED',
        items: [
          { criticalFlag: true, status: 'OPEN' },
        ],
      },
    ];
    // All requests cancelled, service still needs parts → UNCONFIRMED
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('UNCONFIRMED');
  });

  it('handles multiple requests — all ready', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      { status: 'READY', items: [{ criticalFlag: true, status: 'RECEIVED' }] },
      { status: 'CLOSED', items: [{ criticalFlag: true, status: 'CLOSED' }] },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('READY');
  });

  it('handles multiple requests — one not ready', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      { status: 'READY', items: [{ criticalFlag: true, status: 'RECEIVED' }] },
      { status: 'OPEN', items: [{ criticalFlag: true, status: 'OPEN' }] },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('REQUIRED_NOT_READY');
  });

  it('returns NOT_REQUIRED for empty service types and no requests', () => {
    expect(derivePartsReadiness([], [])).toBe('NOT_REQUIRED');
  });

  it('CANCELLED critical items count as resolved', () => {
    const serviceTypes: ServiceTypeInfo[] = [
      { partsPrepositionRequired: true },
    ];
    const requests: PartsRequestInfo[] = [
      {
        status: 'OPEN',
        items: [{ criticalFlag: true, status: 'CANCELLED' }],
      },
    ];
    expect(derivePartsReadiness(serviceTypes, requests)).toBe('READY');
  });
});

describe('isPartsReadyForDispatch', () => {
  it('NOT_REQUIRED is dispatchable', () => {
    expect(isPartsReadyForDispatch('NOT_REQUIRED')).toBe(true);
  });

  it('UNCONFIRMED is dispatchable (warning only)', () => {
    expect(isPartsReadyForDispatch('UNCONFIRMED')).toBe(true);
  });

  it('READY is dispatchable', () => {
    expect(isPartsReadyForDispatch('READY')).toBe(true);
  });

  it('REQUIRED_NOT_READY is NOT dispatchable', () => {
    expect(isPartsReadyForDispatch('REQUIRED_NOT_READY')).toBe(false);
  });
});
