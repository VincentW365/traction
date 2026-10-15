import { describe, it, expect } from 'vitest';
import { explainCameraError } from '../camera-capture';

/**
 * CR-2026-118 §3 — the one piece of the camera control that can be tested
 * without a browser: what the person is told when the camera cannot start.
 * The live-preview, shutter and orientation paths need a real tablet and are
 * verified there (§4.5: "tested on actual tablet browsers").
 */
const err = (name: string) => Object.assign(new Error(name), { name });

describe('camera failures are explained in words someone can act on', () => {
  it('a blocked permission says how to unblock it, and offers the alternative', () => {
    const msg = explainCameraError(err('NotAllowedError'));
    expect(msg).toMatch(/blocked/i);
    expect(msg).toMatch(/browser settings/i);
    expect(msg).toMatch(/Upload existing photo/);
  });

  it('no camera at all points straight to upload', () => {
    expect(explainCameraError(err('NotFoundError'))).toMatch(/No camera was found/);
  });

  it('a camera held by another app says so', () => {
    expect(explainCameraError(err('NotReadableError'))).toMatch(/in use by another app/);
  });

  it('never leaks a raw error name or a stack to the screen', () => {
    for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SomethingNew']) {
      const msg = explainCameraError(err(name));
      expect(msg).not.toMatch(/Error\b/);
      expect(msg).not.toMatch(/undefined|null|\bat\b .*\(/);
    }
  });

  it('an unknown failure still ends with a way forward', () => {
    expect(explainCameraError(new Error('weird'))).toMatch(/Upload existing photo/);
    expect(explainCameraError(undefined)).toMatch(/Upload existing photo/);
  });
});
