'use client';

/**
 * CR-2026-096 — CustomerNotificationComposer.
 *
 * The ONE composer for every staff-initiated customer message: service-due
 * reminders, queue progress updates, pickup notices, and custom messages.
 * Flow: Generate → Review → Edit → Preview → Send. The server generates the
 * drafts from admin-editable templates; staff edit before sending; the exact
 * final text is recorded. Editing a recipient here is a send-to override only —
 * customer master data changes go through the explicit update action.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api-client';
import { useAuth } from '../hooks/use-auth';

export type NotificationReason =
  | 'SERVICE_DUE'
  | 'QUEUE_CHECKED_IN'
  | 'QUEUE_WORK_STARTED'
  | 'QUEUE_UPDATE'
  | 'PICKUP_READY'
  | 'CUSTOM';

const REASON_LABELS: Record<NotificationReason, string> = {
  SERVICE_DUE: 'Vehicle Due for Service',
  QUEUE_CHECKED_IN: 'Checked In',
  QUEUE_WORK_STARTED: 'Work Started',
  QUEUE_UPDATE: 'Service Update',
  PICKUP_READY: 'Vehicle Ready for Pickup',
  CUSTOM: 'Custom Message',
};

/** Queue tickets offer a choice of contextual templates. */
const QUEUE_REASON_CHOICES: NotificationReason[] = [
  'QUEUE_CHECKED_IN',
  'QUEUE_WORK_STARTED',
  'QUEUE_UPDATE',
  'CUSTOM',
];

interface ComposeResponse {
  reason: NotificationReason;
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    allowSms: boolean;
    allowEmail: boolean;
    smsValid: boolean;
    emailValid: boolean;
  };
  vehicle: { id: string; description: string; registration: string } | null;
  visit: { id: string; ticketNumber: string | null; status: string } | null;
  serviceDue: {
    recommendationId: string;
    serviceName: string | null;
    serviceTypeCode: string;
    nextDueDate: string | null;
    nextDueOdometer: number | null;
    lastServiceDate: string | null;
    contactStatus: string;
    lastContactedAt: string | null;
  } | null;
  sms: { templateKey: string; templateVersion: number; enabled: boolean; body: string; chars: number; segments: number } | null;
  email: { templateKey: string; templateVersion: number; enabled: boolean; subject: string; body: string } | null;
  priorSend: { channel: string; sentAt: string | null; createdAt: string; status: string } | null;
  previousContact: { channel: string; sentAt: string | null; createdAt: string; status: string } | null;
  capabilities: { smsConfigured: boolean; emailConfigured: boolean; mode: 'TEST' | 'LIVE'; testRoutingActive: boolean };
}

export interface ComposerContext {
  reason: NotificationReason;
  customerId: string;
  vehicleId?: string;
  serviceVisitId?: string;
  recommendationId?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: ComposerContext;
  /** Show the queue template picker (Checked In / Work Started / Update / Custom). */
  allowReasonChoice?: boolean;
  onSent?: () => void;
}

function smsSegments(body: string): { chars: number; segments: number } {
  const chars = body.length;
  // Client-side estimate; authoritative count is computed server-side.
  const ascii = /^[\x20-\x7e\n\r]*$/.test(body);
  const single = ascii ? 160 : 70;
  const multi = ascii ? 153 : 67;
  return { chars, segments: chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi) };
}

/** CR-2026-106 — one send result per channel, with the state a person should read. */
interface SentEntry {
  channel: string;
  status: string;
  displayState?: string;
  failureReason?: string | null;
  recipient: string;
  testRouted: boolean;
  simulated: boolean;
}

const DISPLAY_STATE_LABELS: Record<string, string> = {
  QUEUED: 'Queued',
  SENDING: 'Sending',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  TEST_REDIRECTED: 'Test redirected',
  SIMULATED: 'Simulated — not delivered',
  MANUAL: 'Logged (manual)',
  CANCELLED: 'Cancelled',
};

function fmtWhen(v: string | null | undefined): string {
  if (!v) return '—';
  return new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function CustomerNotificationComposer({ open, onClose, context, allowReasonChoice, onSent }: Props) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<NotificationReason>(context.reason);
  const [data, setData] = useState<ComposeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [useSms, setUseSms] = useState(false);
  const [useEmail, setUseEmail] = useState(false);
  const [smsTo, setSmsTo] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [overrideOptOut, setOverrideOptOut] = useState(false);
  // CR-2026-106 — the per-channel outcome of the last send; the dialog stays open
  // when any channel FAILED so the reason is read, never a silent "sent".
  const [outcome, setOutcome] = useState<SentEntry[] | null>(null);
  const requestIdRef = useRef<string>('');

  const canEditCustomer = user?.roleCode === 'ADMIN' || user?.roleCode === 'SERVICE_ADVISOR';

  const composeMutation = useMutation<ComposeResponse, unknown, NotificationReason>({
    mutationFn: (r) =>
      api.post<ComposeResponse>('/notifications/compose', { ...context, reason: r }),
    onSuccess: (res) => {
      setData(res);
      setLoadError(null);
      setSmsTo(res.customer.phone ?? '');
      setEmailTo(res.customer.email ?? '');
      setSmsBody(res.sms?.body ?? '');
      setEmailSubject(res.email?.subject ?? '');
      setEmailBody(res.email?.body ?? '');
      const smsOk = res.customer.smsValid && (res.sms?.enabled ?? false);
      setUseSms(smsOk && res.customer.allowSms);
      setUseEmail(false);
      setStep('edit');
      setConfirmDuplicate(false);
      setOverrideOptOut(false);
      setOutcome(null);
    },
    onError: (e) => setLoadError(e instanceof Error ? e.message : 'Failed to load'),
  });

  useEffect(() => {
    if (open) {
      requestIdRef.current = crypto.randomUUID();
      setReason(context.reason);
      setData(null);
      composeMutation.mutate(context.reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const switchReason = (r: NotificationReason) => {
    setReason(r);
    composeMutation.mutate(r);
  };

  const sendMutation = useMutation<
    { duplicate: boolean; sent: SentEntry[] },
    unknown,
    void
  >({
    mutationFn: () =>
      api.post('/notifications/send', {
        ...context,
        reason,
        channels: [...(useSms ? ['SMS'] : []), ...(useEmail ? ['EMAIL'] : [])],
        sms: useSms ? { recipient: smsTo, body: smsBody } : undefined,
        email: useEmail ? { recipient: emailTo, subject: emailSubject, body: emailBody } : undefined,
        confirmDuplicate,
        overrideOptOut,
        clientRequestId: requestIdRef.current,
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['notification-history'] });
      queryClient.invalidateQueries({ queryKey: ['due-vehicles'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      const failed = (res.sent ?? []).some((s) => (s.displayState ?? s.status) === 'FAILED');
      if (failed) {
        setOutcome(res.sent);
        requestIdRef.current = crypto.randomUUID();
        return;
      }
      onSent?.();
      onClose();
    },
  });

  const updateContactMutation = useMutation<unknown, unknown, { phone?: string; email?: string }>({
    mutationFn: (patch) => api.patch(`/customers/${context.customerId}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', context.customerId] });
      composeMutation.mutate(reason);
    },
  });

  const seg = useMemo(() => smsSegments(smsBody), [smsBody]);

  if (!open) return null;

  const caps = data?.capabilities;
  const sendDisabled =
    sendMutation.isPending || (!useSms && !useEmail) || !data;

  const smsOverridden = data && smsTo.trim() !== (data.customer.phone ?? '').trim();
  const emailOverridden = data && emailTo.trim().toLowerCase() !== (data.customer.email ?? '').trim().toLowerCase();

  const smsOptedOut = data ? !data.customer.allowSms : false;
  const emailOptedOut = data ? !data.customer.allowEmail : false;
  const needsOptOutConfirm = (useSms && smsOptedOut) || (useEmail && emailOptedOut);

  const sendErrorInfo = (() => {
    const e = sendMutation.error;
    if (!e) return null;
    if (e instanceof ApiError && e.status === 409) {
      const details = (e.body as { details?: { code?: string; prior?: { channel: string; sentAt: string; status: string } } } | undefined)?.details;
      return { code: details?.code, message: e.message, prior: details?.prior };
    }
    return { code: undefined, message: e instanceof Error ? e.message : 'Send failed', prior: undefined };
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4" onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-2xl sm:rounded-xl rounded-t-xl shadow-xl max-h-[95vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Contact Customer</h2>
            <p className="text-xs text-slate-500">{REASON_LABELS[reason]}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1" aria-label="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          {composeMutation.isPending && <p className="text-sm text-slate-500">Preparing message…</p>}
          {loadError && <p className="text-sm text-red-600">{loadError}</p>}

          {data && (
            <>
              {/* Mode banners */}
              {caps?.testRoutingActive && (
                <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 font-medium">
                  TEST MODE — Customer will not receive this message. Sends are redirected to the configured test recipient.
                </div>
              )}
              {caps && !caps.smsConfigured && !caps.emailConfigured && (
                <div className="mb-3 rounded-md bg-slate-100 border border-slate-200 px-3 py-2 text-xs text-slate-600">
                  Messaging is unavailable — no SMS or email provider is configured. The message will be recorded in history but <span className="font-semibold">not delivered</span>.
                </div>
              )}

              {/* Context */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Customer</p>
                  <p className="font-medium text-slate-900">{data.customer.name}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Vehicle</p>
                  <p className="font-medium text-slate-900">
                    {data.vehicle ? `${data.vehicle.description}${data.vehicle.registration ? ` — ${data.vehicle.registration}` : ''}` : '—'}
                  </p>
                </div>
                {data.visit?.ticketNumber && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-400">Ticket</p>
                    <p className="font-mono text-slate-700">{data.visit.ticketNumber}</p>
                  </div>
                )}
                {data.serviceDue && (
                  <div className="col-span-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-400">Service due</p>
                    <p className="text-slate-700 text-xs">
                      {data.serviceDue.serviceName ?? data.serviceDue.serviceTypeCode}
                      {data.serviceDue.nextDueDate ? ` · due ${new Date(data.serviceDue.nextDueDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
                      {data.serviceDue.nextDueOdometer != null ? ` · at ${data.serviceDue.nextDueOdometer.toLocaleString()} mi` : ''}
                      {data.serviceDue.lastContactedAt ? ` · last contacted ${fmtWhen(data.serviceDue.lastContactedAt)}` : ' · never contacted'}
                    </p>
                  </div>
                )}
              </div>

              {/* Prior-send warnings */}
              {data.priorSend && (
                <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  {REASON_LABELS[reason]} notification already sent — {data.priorSend.channel} · {fmtWhen(data.priorSend.sentAt ?? data.priorSend.createdAt)} · {data.priorSend.status}
                  {reason === 'PICKUP_READY' && (
                    <label className="flex items-center gap-2 mt-1 font-medium">
                      <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} />
                      Send another anyway
                    </label>
                  )}
                </div>
              )}
              {data.previousContact && !data.priorSend && (
                <div className="mb-3 rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600">
                  Previously contacted — {data.previousContact.channel} · {fmtWhen(data.previousContact.sentAt ?? data.previousContact.createdAt)} · {data.previousContact.status}
                </div>
              )}

              {/* Queue template choice */}
              {allowReasonChoice && (
                <div className="mb-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Message type</p>
                  <div className="flex flex-wrap gap-1.5">
                    {QUEUE_REASON_CHOICES.map((r) => (
                      <button
                        key={r}
                        onClick={() => switchReason(r)}
                        className={`text-xs px-2.5 py-1 rounded-full border ${reason === r ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-300 text-slate-600 hover:border-blue-400'}`}
                      >
                        {REASON_LABELS[r]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Channels */}
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Send via</p>
              <div className="flex gap-4 mb-3">
                <label className={`flex items-center gap-2 text-sm ${!data.customer.smsValid ? 'text-slate-400' : 'text-slate-700'}`}>
                  <input type="checkbox" checked={useSms} disabled={!data.customer.smsValid} onChange={(e) => setUseSms(e.target.checked)} />
                  SMS
                  {smsOptedOut && <span className="badge bg-red-50 text-red-600 text-[10px]">opted out</span>}
                </label>
                <label className={`flex items-center gap-2 text-sm ${!data.customer.emailValid ? 'text-slate-400' : 'text-slate-700'}`}>
                  <input type="checkbox" checked={useEmail} disabled={!data.customer.emailValid} onChange={(e) => setUseEmail(e.target.checked)} />
                  Email
                  {emailOptedOut && <span className="badge bg-red-50 text-red-600 text-[10px]">opted out</span>}
                </label>
              </div>
              {!data.customer.smsValid && <p className="text-xs text-red-600 mb-1">No valid mobile number available.</p>}
              {!data.customer.emailValid && <p className="text-xs text-red-600 mb-2">No valid email address available.</p>}

              {step === 'edit' ? (
                <>
                  {/* SMS */}
                  {useSms && (
                    <div className="mb-4 border border-slate-200 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-semibold text-slate-700">SMS</p>
                        <button onClick={() => setSmsBody(data.sms?.body ?? '')} className="text-[11px] text-blue-600 hover:underline">Reset to Template</button>
                      </div>
                      <label className="block text-[11px] text-slate-500 mb-0.5">Mobile</label>
                      <input value={smsTo} onChange={(e) => setSmsTo(e.target.value)} className="input-field text-sm mb-1" />
                      {smsOverridden && (
                        <div className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1 mb-2 flex items-center justify-between gap-2">
                          <span>Send-to override — the customer record is not changed.</span>
                          {canEditCustomer && (
                            <button
                              onClick={() => updateContactMutation.mutate({ phone: smsTo.trim() })}
                              disabled={updateContactMutation.isPending}
                              className="underline whitespace-nowrap"
                            >
                              Update customer record
                            </button>
                          )}
                        </div>
                      )}
                      <label className="block text-[11px] text-slate-500 mb-0.5">Message</label>
                      <textarea value={smsBody} onChange={(e) => setSmsBody(e.target.value)} rows={4} className="input-field text-sm font-normal" />
                      <p className={`text-[11px] mt-1 ${seg.segments > 3 ? 'text-amber-600 font-medium' : 'text-slate-400'}`}>
                        {seg.chars} characters · ~{seg.segments} SMS segment{seg.segments === 1 ? '' : 's'}
                        {seg.segments > 3 ? ' — unusually long for an SMS; consider email for details' : ''}
                      </p>
                    </div>
                  )}

                  {/* Email */}
                  {useEmail && (
                    <div className="mb-4 border border-slate-200 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-semibold text-slate-700">Email</p>
                        <button
                          onClick={() => { setEmailSubject(data.email?.subject ?? ''); setEmailBody(data.email?.body ?? ''); }}
                          className="text-[11px] text-blue-600 hover:underline"
                        >
                          Reset to Template
                        </button>
                      </div>
                      <label className="block text-[11px] text-slate-500 mb-0.5">Email address</label>
                      <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} className="input-field text-sm mb-1" />
                      {emailOverridden && (
                        <div className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1 mb-2 flex items-center justify-between gap-2">
                          <span>Send-to override — the customer record is not changed.</span>
                          {canEditCustomer && (
                            <button
                              onClick={() => updateContactMutation.mutate({ email: emailTo.trim() })}
                              disabled={updateContactMutation.isPending}
                              className="underline whitespace-nowrap"
                            >
                              Update customer record
                            </button>
                          )}
                        </div>
                      )}
                      <label className="block text-[11px] text-slate-500 mb-0.5">Subject</label>
                      <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} className="input-field text-sm mb-2" />
                      <label className="block text-[11px] text-slate-500 mb-0.5">Message</label>
                      <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={8} className="input-field text-sm font-normal" />
                    </div>
                  )}

                  {reason === 'QUEUE_UPDATE' && useSms && smsBody === (data.sms?.body ?? '') && (
                    <p className="text-xs text-amber-700 mb-2">
                      Add the update details for the customer — the template leaves that part to you.
                    </p>
                  )}
                </>
              ) : (
                /* Preview */
                <div className="space-y-3">
                  {useSms && (
                    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                      <p className="text-xs font-semibold text-slate-700 mb-1">SMS → {smsTo}</p>
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{smsBody}</p>
                      <p className="text-[11px] text-slate-400 mt-1">{seg.chars} characters · ~{seg.segments} segment{seg.segments === 1 ? '' : 's'}</p>
                    </div>
                  )}
                  {useEmail && (
                    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                      <p className="text-xs font-semibold text-slate-700 mb-1">Email → {emailTo}</p>
                      <p className="text-sm font-medium text-slate-900 mb-1">{emailSubject}</p>
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{emailBody}</p>
                    </div>
                  )}
                  {caps?.testRoutingActive && (
                    <p className="text-xs text-amber-700 font-medium">TEST MODE — this will be delivered to the test recipient, not the customer.</p>
                  )}
                </div>
              )}

              {/* Opt-out confirmation */}
              {needsOptOutConfirm && (
                <label className="flex items-center gap-2 text-xs text-red-700 bg-red-50 rounded-md px-3 py-2 mb-2">
                  <input type="checkbox" checked={overrideOptOut} onChange={(e) => setOverrideOptOut(e.target.checked)} />
                  The customer opted out of {useSms && smsOptedOut ? 'SMS' : ''}{useSms && smsOptedOut && useEmail && emailOptedOut ? ' and ' : ''}{useEmail && emailOptedOut ? 'email' : ''} messages. I confirm this operational message should still be sent.
                </label>
              )}

              {outcome && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 mb-2 text-xs" data-testid="send-outcome">
                  <p className="font-semibold text-red-800 mb-1">Not every channel got through</p>
                  <ul className="space-y-0.5">
                    {outcome.map((s) => (
                      <li key={s.channel} className={(s.displayState ?? s.status) === 'FAILED' ? 'text-red-700' : 'text-slate-700'}>
                        <span className="font-medium">{s.channel}</span> → {DISPLAY_STATE_LABELS[s.displayState ?? s.status] ?? s.status}
                        {s.failureReason ? ` — ${s.failureReason}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-slate-600">The failed message is recorded in history as Failed. Fix the address or the email setup, then send again.</p>
                </div>
              )}

              {sendErrorInfo && (
                <div className="text-xs text-red-600 bg-red-50 rounded-md px-3 py-2 mb-2">
                  {sendErrorInfo.code === 'DUPLICATE_PICKUP' && sendErrorInfo.prior ? (
                    <>
                      A pickup notification was already sent at {fmtWhen(sendErrorInfo.prior.sentAt)} ({sendErrorInfo.prior.channel}). Tick “Send another anyway” above to resend.
                    </>
                  ) : (
                    sendErrorInfo.message
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-2 shrink-0">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <div className="flex items-center gap-2">
            {step === 'preview' && (
              <button onClick={() => setStep('edit')} className="btn-secondary text-sm">Back to Edit</button>
            )}
            {step === 'edit' ? (
              <button onClick={() => setStep('preview')} disabled={sendDisabled} className="btn-primary text-sm">
                Preview
              </button>
            ) : (
              <button
                onClick={() => sendMutation.mutate()}
                disabled={sendDisabled || (needsOptOutConfirm && !overrideOptOut)}
                className="btn-primary text-sm"
              >
                {sendMutation.isPending ? 'Sending…' : 'Send Notification'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
