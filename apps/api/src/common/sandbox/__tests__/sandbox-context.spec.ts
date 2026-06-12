import { describe, it, expect } from 'vitest';
import { SandboxContextService } from '../sandbox-context.service';

describe('SandboxContextService (CR-2026-023)', () => {
  it('exposes the run id inside run(), undefined outside (and restores after)', () => {
    const s = new SandboxContextService();
    expect(s.getRunId()).toBeUndefined();
    const inside = s.run('run-1', () => s.getRunId());
    expect(inside).toBe('run-1');
    expect(s.getRunId()).toBeUndefined();
  });

  it('propagates across async/await boundaries', async () => {
    const s = new SandboxContextService();
    const v = await s.run('run-2', async () => {
      await Promise.resolve();
      return s.getRunId();
    });
    expect(v).toBe('run-2');
    expect(s.getRunId()).toBeUndefined();
  });
});
