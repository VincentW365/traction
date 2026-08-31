import { describe, it, expect, vi } from 'vitest';
import { ChannelRouterProvider, SmtpNotificationProvider } from '../smtp.provider';

/** CR-2026-099 — SMTP email provider + channel router. */

describe('SmtpNotificationProvider', () => {
  const build = (sendMail = vi.fn(async () => ({ messageId: 'msg-1' }))) => ({
    provider: new SmtpNotificationProvider({ from: "Bert's <service@berts.example>" }, { sendMail }),
    sendMail,
  });

  it('sends the pre-rendered subject and body to the recipient', async () => {
    const { provider, sendMail } = build();
    const r = await provider.send({
      channel: 'EMAIL', recipient: 'customer@example.com', templateKey: 'SERVICE_DUE_EMAIL',
      templateData: {}, subject: 'Service Reminder — 1234 AB', body: 'Hi Vincent, …',
    });
    expect(r.success).toBe(true);
    expect(r.providerReference).toBe('msg-1');
    expect(sendMail).toHaveBeenCalledWith({
      from: "Bert's <service@berts.example>",
      to: 'customer@example.com',
      subject: 'Service Reminder — 1234 AB',
      text: 'Hi Vincent, …',
    });
  });

  it('a transport failure is a recorded failure, never a crash or a false success', async () => {
    const { provider } = build(vi.fn(async () => { throw new Error('535 auth failed'); }));
    const r = await provider.send({
      channel: 'EMAIL', recipient: 'x@example.com', templateKey: 'k', templateData: {}, subject: 's', body: 'b',
    });
    expect(r.success).toBe(false);
    expect(r.failureReason).toContain('535');
  });

  it('refuses non-EMAIL channels and empty bodies', async () => {
    const { provider, sendMail } = build();
    const sms = await provider.send({ channel: 'SMS', recipient: 'x', templateKey: 'k', templateData: {}, body: 'hi' });
    expect(sms.success).toBe(false);
    const empty = await provider.send({ channel: 'EMAIL', recipient: 'x@example.com', templateKey: 'k', templateData: {}, subject: 's', body: '  ' });
    expect(empty.success).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('ChannelRouterProvider', () => {
  it('routes SMS and EMAIL to their own providers', async () => {
    const sms = { send: vi.fn(async () => ({ success: true, providerReference: 'sms' })) };
    const email = { send: vi.fn(async () => ({ success: true, providerReference: 'email' })) };
    const router = new ChannelRouterProvider(sms, email);

    const a = await router.send({ channel: 'SMS', recipient: 'x', templateKey: 'k', templateData: {} });
    const b = await router.send({ channel: 'EMAIL', recipient: 'y', templateKey: 'k', templateData: {} });
    expect(a.providerReference).toBe('sms');
    expect(b.providerReference).toBe('email');
    expect(sms.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledOnce();
  });
});
