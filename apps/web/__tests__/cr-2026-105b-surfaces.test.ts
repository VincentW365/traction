import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-105b — static surface checks: every screen that shows an estimate goes
 * through the shared formatter, the public surfaces never render confidence
 * reasons, staff pages subscribe to the queue socket, and the rules are editable.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('CR-2026-105b — authoritative ETA surfaces', () => {
  it('shared formatter + socket hook exist', () => {
    expect(fs.existsSync(path.join(root, 'lib/eta-format.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'hooks/use-queue-socket.ts'))).toBe(true);
    expect(read('lib/eta-format.ts')).toContain('fmtEtaWindow');
    expect(read('hooks/use-queue-socket.ts')).toContain("'queue:updated'");
  });

  it('lobby display shows estimated start/done, delayed copy, and never confidence reasons', () => {
    const src = read('app/display/[token]/page.tsx');
    expect(src).toContain('Est. start');
    expect(src).toContain('Est. done');
    expect(src).toContain('Updated est.');
    expect(src).toContain('Finishing up');
    expect(src).toContain('PublicEta');
    expect(src).not.toContain('CONFIDENCE_LABEL');
    expect(src).not.toContain('AT_RISK');
  });

  it('customer status page shows the estimate without confidence reasons', () => {
    const src = read('app/status/[token]/page.tsx');
    expect(src).toContain('Est. completion');
    expect(src).toContain('PublicEta');
    expect(src).not.toContain('CONFIDENCE_LABEL');
  });

  it('staff surfaces show expected completion + On Track / At Risk / Delayed and subscribe live', () => {
    for (const p of [
      'app/(dashboard)/dispatch/page.tsx',
      'app/(dashboard)/visits/[id]/page.tsx',
      'app/(dashboard)/technician/page.tsx',
      'app/(dashboard)/technician/jobs/[orderId]/page.tsx',
      'app/(dashboard)/queue/[id]/page.tsx',
    ]) {
      const src = read(p);
      expect(src, p).toContain('useQueueSocket(');
      expect(src, p).toContain('CONFIDENCE_LABEL');
      expect(src, p).toContain('fmtEtaWindow(');
    }
    const board = read('app/(dashboard)/queue/page.tsx');
    expect(board).toContain('useQueueSocket(');
    expect(board).toContain('fmtEtaWindow(');
  });

  it('Visit Record shows scheduled start, actual start, estimated completion, actual completion', () => {
    const src = read('app/(dashboard)/visits/[id]/page.tsx');
    for (const label of ['Scheduled start', 'Actual start', 'Estimated completion', 'Actual completion']) {
      expect(src).toContain(label);
    }
  });

  it('the ETA / capacity rules are editable under Settings', () => {
    // CR-2026-109 — the key list moved out of the page into the settings
    // catalogue, which is now what decides where a rule appears and what it is
    // called. The guarantee is the same one: these rules stay editable.
    const src = read('lib/settings-catalogue.ts');
    expect(src).toContain("key: 'default_appointment_duration_minutes'");
    expect(src).toContain("key: 'booking_max_concurrent_appointments'");
    expect(src).toContain("key: 'overdue_job_minutes'");
    // ...and under a heading a manager can find, rather than a database term.
    expect(src).toContain("title: 'Booking & Scheduling'");
    expect(src).toContain("title: 'Scheduling model'");
  });
});
