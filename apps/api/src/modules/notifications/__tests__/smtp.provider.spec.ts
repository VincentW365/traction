import { describe, it, expect, vi } from 'vitest';
import { ChannelRouterProvider, SmtpNotificationProvider } from '../providers/smtp.provider';

/** CR-2026-106 — the SMTP provider reports the mail server's verdict, not just "no exception". */

const input = { channel: 'EMAIL' as const, recipient: 'a@b.c', templateKey: 'x', templateData: {}, subject: 'S', body: 'B' };

describe('SmtpNotificationProvider', () => {
  it('a rejected recipient is a FAILURE even when a message id came back', async () => {
    const transport = { sendMail: vi.fn(async () => ({ messageId: 'm1', accepted: [], rejected: ['a@b.c'], response: '550 5.1.1 user unknown' })) };
    const p = new SmtpNotificationProvider({ from: 'svc@x.y' }, transport);
    const r = await p.send(input);
    expect(r.success).toBe(false);
    expect(r.failureReason).toMatch(/550/);
    expect(r.rejected).toEqual(['a@b.c']);
  });

  it('an accepted recipient is a success carrying the server response', async () => {
    const transport = { sendMail: vi.fn(async () => ({ messageId: 'm1', accepted: ['a@b.c'], rejected: [], response: '250 2.0.0 OK' })) };
    const p = new SmtpNotificationProvider({ from: 'svc@x.y' }, transport);
    const r = await p.send(input);
    expect(r).toMatchObject({ success: true, providerReference: 'm1', accepted: ['a@b.c'], response: '250 2.0.0 OK' });
  });

  it('still refuses an empty body (the reason the legacy flows used to fail)', async () => {
    const transport = { sendMail: vi.fn() };
    const p = new SmtpNotificationProvider({ from: 'svc@x.y' }, transport);
    const r = await p.send({ ...input, body: '   ' });
    expect(r).toEqual({ success: false, failureReason: 'Empty email body' });
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('verify() surfaces the transport error text', async () => {
    const transport = { sendMail: vi.fn(), verify: vi.fn(async (): Promise<unknown> => { throw new Error('Invalid login: 535'); }) };
    const p = new SmtpNotificationProvider({ from: 'svc@x.y' }, transport);
    expect(await p.verify('EMAIL')).toEqual({ ok: false, detail: 'Invalid login: 535' });
    transport.verify.mockResolvedValueOnce(true);
    expect(await p.verify('EMAIL')).toEqual({ ok: true, detail: 'connected and authenticated' });
  });
});

describe('ChannelRouterProvider', () => {
  it('routes verify() to the email provider for EMAIL and reports when a provider cannot verify', async () => {
    const sms = { send: vi.fn() };
    const email = { send: vi.fn(), verify: vi.fn(async () => ({ ok: true, detail: 'ok' })) };
    const router = new ChannelRouterProvider(sms, email);
    expect(await router.verify('EMAIL')).toEqual({ ok: true, detail: 'ok' });
    expect((await router.verify('SMS')).ok).toBe(false);
  });
});
