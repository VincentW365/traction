/**
 * CR-2026-092 — which order lines get a qualifier control, and how an answered one
 * reads back.
 *
 * Pure-logic tests, matching the app's existing no-DOM vitest setup.
 */
import { describe, it, expect } from 'vitest';
import {
  qualifierPrompts,
  qualifierSummary,
  showBrakeAxle,
  type MissingQualifier,
  type QualifierItem,
} from '../lib/service-qualifiers';

const line = (id: string, over: Partial<QualifierItem> = {}): QualifierItem => ({
  id,
  serviceType: { id: `st-${id}`, name: `Service ${id}`, code: `SVC-${id}` },
  axlePosition: null,
  brakeWorkType: null,
  tireOperation: null,
  ...over,
});

const missing = (lineId: string, requiredQualifier: MissingQualifier['requiredQualifier']): MissingQualifier => ({
  lineId,
  serviceCode: `SVC-${lineId}`,
  serviceName: `Service ${lineId}`,
  requiredQualifier,
  message: `Answer ${lineId}`,
});

describe('qualifierPrompts', () => {
  it('prompts the lines the API reports as outstanding, and no others', () => {
    const items = [line('a'), line('b'), line('c')];
    const prompts = qualifierPrompts(items, [missing('b', 'BRAKE')]);
    expect(prompts.map((p) => p.item.id)).toEqual(['b']);
    expect(prompts[0]).toMatchObject({ kind: 'BRAKE', message: 'Answer b' });
  });

  it('keeps a control on an already-answered line so a wrong answer can be corrected', () => {
    const items = [
      line('a', { brakeWorkType: 'PADS', axlePosition: 'FRONT' }),
      line('b', { tireOperation: 'ROTATION' }),
      line('c', { axlePosition: 'REAR' }),
    ];
    const prompts = qualifierPrompts(items, []);
    expect(prompts.map((p) => [p.item.id, p.kind, p.message])).toEqual([
      ['a', 'BRAKE', null],
      ['b', 'TIRE_OPERATION', null],
      ['c', 'BRAKE', null],
    ]);
  });

  it('ignores a missing entry that names no usable qualifier', () => {
    expect(qualifierPrompts([line('a')], [missing('a', 'NONE')])).toEqual([]);
  });
});

describe('showBrakeAxle', () => {
  it('is not asked for an inspection', () => {
    expect(showBrakeAxle(line('a', { brakeWorkType: 'INSPECTION_ONLY' }))).toBe(false);
    expect(
      showBrakeAxle(line('a', { brakeWorkType: 'INSPECTION_ONLY', axlePosition: 'FRONT' })),
    ).toBe(false);
  });

  it('waits for a work type, but stays put once an axle has been recorded', () => {
    expect(showBrakeAxle(line('a'))).toBe(false);
    expect(showBrakeAxle(line('a', { brakeWorkType: 'PADS' }))).toBe(true);
    expect(showBrakeAxle(line('a', { axlePosition: 'REAR' }))).toBe(true);
  });
});

describe('qualifierSummary', () => {
  it('reads back as the breakdown labels it', () => {
    expect(qualifierSummary(line('a', { brakeWorkType: 'PADS', axlePosition: 'FRONT' }))).toBe(
      'Front · Pads',
    );
    expect(
      qualifierSummary(line('a', { brakeWorkType: 'SHOES', axlePosition: 'FRONT_AND_REAR' })),
    ).toBe('Front & rear · Shoes');
    expect(qualifierSummary(line('a', { tireOperation: 'ALIGNMENT' }))).toBe('Tyre · Alignment');
    expect(qualifierSummary(line('a', { brakeWorkType: 'INSPECTION_ONLY' }))).toBe(
      'Inspection only',
    );
  });

  it('never presents NOT_APPLICABLE as an axle for brake work', () => {
    expect(
      qualifierSummary(line('a', { brakeWorkType: 'PADS', axlePosition: 'NOT_APPLICABLE' })),
    ).toBe('Pads');
  });

  it('is null for a line carrying nothing', () => {
    expect(qualifierSummary(line('a'))).toBeNull();
  });
});
