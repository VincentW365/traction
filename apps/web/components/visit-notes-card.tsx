'use client';

/**
 * CR-2026-101 — typed operational notes on a visit (§13).
 *
 * One card, every role: the customer's concern, advisor context, manager
 * instructions and technician findings stay distinguishable — author, role and
 * time on every row. Which kinds the CURRENT user may add is decided by the
 * caller (and enforced again server-side); SAFETY and DATA_REPORT always go to
 * the advisor/manager attention queue.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api-client';

export interface VisitNoteRow {
  id: string;
  serviceOrderId: string | null;
  kind: 'CUSTOMER_CONCERN' | 'ADVISOR' | 'MANAGER' | 'TECHNICIAN' | 'SAFETY' | 'DATA_REPORT';
  text: string;
  authorName: string | null;
  authorRole: string;
  requiresAttention: boolean;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNotes: string | null;
  createdAt: string;
}

export const NOTE_KIND_LABEL: Record<VisitNoteRow['kind'], string> = {
  CUSTOMER_CONCERN: 'Customer concern',
  ADVISOR: 'Advisor note',
  MANAGER: 'Manager instruction',
  TECHNICIAN: 'Technician note',
  SAFETY: 'Safety concern',
  DATA_REPORT: 'Incorrect information',
};

const KIND_STYLE: Record<VisitNoteRow['kind'], string> = {
  CUSTOMER_CONCERN: 'bg-blue-50 text-blue-800 border-blue-200',
  ADVISOR: 'bg-slate-50 text-slate-700 border-slate-200',
  MANAGER: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  TECHNICIAN: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  SAFETY: 'bg-red-50 text-red-800 border-red-200',
  DATA_REPORT: 'bg-amber-50 text-amber-900 border-amber-200',
};

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Manager',
  SERVICE_ADVISOR: 'Advisor',
  TECHNICIAN: 'Technician',
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function VisitNotesCard({
  visitId,
  serviceOrderId,
  addableKinds,
  canResolve = false,
  title = 'Notes',
}: {
  visitId: string;
  /** Attach new notes to this job on the visit (optional). */
  serviceOrderId?: string;
  /** Which kinds the current user may add (server enforces again). */
  addableKinds: VisitNoteRow['kind'][];
  canResolve?: boolean;
  title?: string;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<VisitNoteRow['kind']>(addableKinds[0] ?? 'TECHNICIAN');
  const [text, setText] = useState('');
  const [requestAttention, setRequestAttention] = useState(false);

  const notesQuery = useQuery<VisitNoteRow[]>({
    queryKey: ['visit-notes', visitId],
    queryFn: () => api.get(`/service-visits/${visitId}/notes`),
    enabled: !!visitId,
  });

  const addNote = useMutation({
    mutationFn: () =>
      api.post(`/service-visits/${visitId}/notes`, {
        kind,
        text: text.trim(),
        ...(serviceOrderId ? { serviceOrderId } : {}),
        ...(requestAttention && kind === 'TECHNICIAN' ? { requestAttention: true } : {}),
      }),
    onSuccess: () => {
      setAdding(false);
      setText('');
      setRequestAttention(false);
      queryClient.invalidateQueries({ queryKey: ['visit-notes', visitId] });
    },
  });

  const resolveNote = useMutation({
    mutationFn: (noteId: string) => api.post(`/visit-notes/${noteId}/resolve`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['visit-notes', visitId] }),
  });

  const notes = notesQuery.data ?? [];

  return (
    <div className="card">
      <div className="card-header flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {addableKinds.length > 0 && !adding && (
          <button onClick={() => setAdding(true)} className="btn-secondary text-xs px-2.5 py-1">
            Add Note
          </button>
        )}
      </div>
      <div className="card-body space-y-2">
        {adding && (
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <select value={kind} onChange={(e) => setKind(e.target.value as VisitNoteRow['kind'])} className="input-field text-sm">
              {addableKinds.map((k) => (
                <option key={k} value={k}>{NOTE_KIND_LABEL[k]}</option>
              ))}
            </select>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder={
                kind === 'DATA_REPORT'
                  ? 'What information is wrong, and what should it be? An advisor/manager will correct the record.'
                  : kind === 'SAFETY'
                    ? 'Describe the safety concern — this goes straight to the advisor/manager.'
                    : 'Write the note…'
              }
              className="input-field text-sm"
            />
            {kind === 'TECHNICIAN' && (
              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={requestAttention} onChange={(e) => setRequestAttention(e.target.checked)} />
                Needs advisor/manager attention
              </label>
            )}
            {(kind === 'SAFETY' || kind === 'DATA_REPORT') && (
              <p className="text-[11px] text-amber-800">
                This is sent to the advisor/manager for action and stays on record.
              </p>
            )}
            {addNote.isError && (
              <p className="text-xs text-red-600">{addNote.error instanceof Error ? addNote.error.message : 'Failed to save'}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => addNote.mutate()}
                disabled={!text.trim() || addNote.isPending}
                className="btn-primary text-xs px-3 py-1.5"
              >
                {addNote.isPending ? 'Saving…' : 'Save Note'}
              </button>
              <button onClick={() => { setAdding(false); setText(''); }} className="btn-secondary text-xs px-3 py-1.5">
                Cancel
              </button>
            </div>
          </div>
        )}

        {notesQuery.isLoading && <p className="text-xs text-slate-500">Loading notes…</p>}
        {notesQuery.isError && (
          <p className="text-xs text-red-600">
            Could not load notes.{notesQuery.error instanceof Error ? ` ${notesQuery.error.message}` : ''}
          </p>
        )}
        {notesQuery.isSuccess && notes.length === 0 && !adding && (
          <p className="text-xs text-slate-400">No notes on this visit yet.</p>
        )}

        {notes.map((n) => (
          <div key={n.id} className={`rounded-lg border p-2.5 ${KIND_STYLE[n.kind]}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide">{NOTE_KIND_LABEL[n.kind]}</span>
              <span className="text-[11px] opacity-70">
                {n.authorName ?? ROLE_LABEL[n.authorRole] ?? n.authorRole} · {fmtWhen(n.createdAt)}
              </span>
            </div>
            <p className="text-sm mt-1 whitespace-pre-wrap">{n.text}</p>
            {n.requiresAttention && !n.resolvedAt && (
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[11px] font-semibold">Awaiting advisor/manager action</span>
                {canResolve && (
                  <button
                    onClick={() => resolveNote.mutate(n.id)}
                    disabled={resolveNote.isPending}
                    className="btn-secondary text-[11px] px-2 py-0.5"
                  >
                    Mark handled
                  </button>
                )}
              </div>
            )}
            {n.resolvedAt && (
              <p className="text-[11px] mt-1 opacity-70">
                Handled{n.resolvedByName ? ` by ${n.resolvedByName}` : ''} · {fmtWhen(n.resolvedAt)}
                {n.resolutionNotes ? ` — ${n.resolutionNotes}` : ''}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
