import { describe, it, expect, vi } from 'vitest';
import { TwilioNotificationProvider, toE164Jamaica } from '../twilio.provider';

/** CR-2026-033 — Twilio provider (mocked client; no live calls), E.164, EMAIL fallback. */

type CreateOpts = { to: string; body: string; from?: string; messagingServiceSid?: string };
function okClient() {
  return { messages: { create: vi.fn(async (_opts: CreateOpts) => ({ sid: 'SM123' })) } };
}
function emailFallback() {
  return { send: vi.fn(async () => ({ success: true, providerReference: 'email-stub' })) };
}

describe('toE164Jamaica (CR-2026-033)', () => {
  it('normalizes common Jamaican formats', () => {
    expect(toE164Jamaica('876-555-1234')).toBe('+18765551234'); // 10 digits
    expect(toE164Jamaica('18765551234')).toBe('+18765551234'); // 11 with leading 1
    expect(toE164Jamaica('555-1234')).toBe('+18765551234'); // 7-digit local → assume 876
    expect(toE164Jamaica('+1 (876) 555-1234')).toBe('+18765551234'); // already +1 w/ punctuation
  });
});

describe('TwilioNotificationProvider.send (CR-2026-033)', () => {
  it('sends SMS via Twilio, normalizes the number, renders the body, maps the sid', async () => {
    const client = okClient();
    const provider = new TwilioNotificationProvider({ fromNumber: '+18001234567' }, client as any, emailFallback() as any);
    const res = await provider.send({
      channel: 'SMS',
      recipient: '876-555-1234',
      templateKey: 'ready_for_pickup',
      templateData: { vehiclePlate: 'ABC123', siteName: "Bert's" },
    });
    expect(res).toEqual({ success: true, providerReference: 'SM123' });
    const arg = client.messages.create.mock.calls[0][0];
    expect(arg.to).toBe('+18765551234');
    expect(arg.from).toBe('+18001234567');
    expect(arg.messagingServiceSid).toBeUndefined();
    expect(arg.body).toMatch(/ready for pickup/i);
  });

  it('uses messagingServiceSid when configured (no from)', async () => {
    const client = okClient();
    const provider = new TwilioNotificationProvider({ messagingServiceSid: 'MG1' }, client as any, emailFallback() as any);
    await provider.send({ channel: 'SMS', recipient: '8765551234', templateKey: 'pickup_ready', templateData: {} });
    const arg = client.messages.create.mock.calls[0][0];
    expect(arg.messagingServiceSid).toBe('MG1');
    expect(arg.from).toBeUndefined();
  });

  it('maps a Twilio error to a failure result without throwing', async () => {
    const client = { messages: { create: vi.fn(async () => { throw new Error('boom'); }) } };
    const provider = new TwilioNotificationProvider({ fromNumber: '+1' }, client as any, emailFallback() as any);
    const res = await provider.send({ channel: 'SMS', recipient: '8765551234', templateKey: 'x', templateData: {} });
    expect(res.success).toBe(false);
    expect(res.failureReason).toBe('boom');
  });

  it('delegates EMAIL to the fallback (Twilio is SMS-only)', async () => {
    const client = okClient();
    const fallback = emailFallback();
    const provider = new TwilioNotificationProvider({ fromNumber: '+1' }, client as any, fallback as any);
    const res = await provider.send({ channel: 'EMAIL', recipient: 'a@b.com', templateKey: 'x', templateData: {} });
    expect(fallback.send).toHaveBeenCalledOnce();
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, providerReference: 'email-stub' });
  });
});
