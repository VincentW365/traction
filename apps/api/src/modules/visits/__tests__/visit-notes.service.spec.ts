import { describe, it, expect, vi } from 'vitest';
import { VisitNotesService } from '../visit-notes.service';

/**
 * CR-2026-101 — typed visit notes with server-side role separation.
 *
 * A technician records findings, safety flags and incorrect-data reports —
 * never customer concerns or manager instructions. Attention items resolve in
 * the open; nothing is deleted.
 */

function build(overrides: any = {}) {
  const prisma: any = {
    serviceVisit: { findUnique: vi.fn(async () => ({ id: 'sv-1' })) },
    serviceOrder: { findFirst: vi.fn(async () => ({ id: 'so-1' })) },
    visitNote: {
      create: vi.fn(async ({ data }: any) => ({ id: 'n-1', ...data })),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async ({ data }: any) => ({ id: 'n-1', ...data })),
    },
    userAccount: { findMany: vi.fn(async () => []) },
    ...overrides,
  };
  const audit = { log: vi.fn(async () => ({})) };
  return { service: new VisitNotesService(prisma as any, audit as any), prisma, audit };
}

const tech = { sub: 'u-tech', role: 'TECHNICIAN' };
const advisor = { sub: 'u-adv', role: 'SERVICE_ADVISOR' };
const admin = { sub: 'u-adm', role: 'ADMIN' };

describe('role-gated note kinds (server-side, §2/§13/§19)', () => {
  it('a technician records a TECHNICIAN finding', async () => {
    const h = build();
    await h.service.addNote('sv-1', { kind: 'TECHNICIAN', text: 'Front pads at 2mm' } as never, tech);
    expect(h.prisma.visitNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'TECHNICIAN',
          authorUserId: 'u-tech',
          authorRole: 'TECHNICIAN',
          requiresAttention: false,
        }),
      }),
    );
  });

  it('a technician CANNOT write a customer concern or a manager instruction', async () => {
    const h = build();
    await expect(
      h.service.addNote('sv-1', { kind: 'CUSTOMER_CONCERN', text: 'x' } as never, tech),
    ).rejects.toThrow(/cannot record/i);
    await expect(
      h.service.addNote('sv-1', { kind: 'MANAGER', text: 'x' } as never, tech),
    ).rejects.toThrow(/cannot record/i);
  });

  it('an advisor cannot write a MANAGER instruction; a manager can', async () => {
    const h = build();
    await expect(
      h.service.addNote('sv-1', { kind: 'MANAGER', text: 'x' } as never, advisor),
    ).rejects.toThrow(/cannot record/i);
    await h.service.addNote('sv-1', { kind: 'MANAGER', text: 'Prioritise this car' } as never, admin);
    expect(h.prisma.visitNote.create).toHaveBeenCalledTimes(1);
  });

  it('SAFETY and DATA_REPORT always require attention and are audited', async () => {
    const h = build();
    await h.service.addNote('sv-1', { kind: 'SAFETY', text: 'Brake line perished' } as never, tech);
    expect(h.prisma.visitNote.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ requiresAttention: true }) }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SAFETY_CONCERN_RAISED' }),
    );

    await h.service.addNote(
      'sv-1',
      { kind: 'DATA_REPORT', text: 'Phone number is out of date' } as never,
      tech,
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DATA_CORRECTION_REPORTED' }),
    );
  });

  it('a TECHNICIAN note can explicitly request attention', async () => {
    const h = build();
    await h.service.addNote(
      'sv-1',
      { kind: 'TECHNICIAN', text: 'Need an advisor decision', requestAttention: true } as never,
      tech,
    );
    expect(h.prisma.visitNote.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ requiresAttention: true }) }),
    );
  });

  it('rejects an empty note and a serviceOrderId from another visit', async () => {
    const h = build({ serviceOrder: { findFirst: vi.fn(async () => null) } });
    await expect(h.service.addNote('sv-1', { kind: 'TECHNICIAN', text: '  ' } as never, tech)).rejects.toThrow(
      /text/i,
    );
    await expect(
      h.service.addNote(
        'sv-1',
        { kind: 'TECHNICIAN', text: 'x', serviceOrderId: 'so-other' } as never,
        tech,
      ),
    ).rejects.toThrow(/does not belong/i);
  });
});

describe('resolution (recorded, never deleted)', () => {
  const openNote = {
    id: 'n-1',
    kind: 'DATA_REPORT',
    text: 'Wrong phone',
    requiresAttention: true,
    resolvedAt: null,
  };

  it('resolves an attention item with who/when/what, audited', async () => {
    const h = build({
      visitNote: {
        findUnique: vi.fn(async () => openNote),
        update: vi.fn(async ({ data }: any) => ({ ...openNote, ...data })),
        create: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });
    await h.service.resolve('n-1', 'Number corrected with the customer', 'u-adv');
    expect(h.prisma.visitNote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolvedByUserId: 'u-adv',
          resolutionNotes: 'Number corrected with the customer',
        }),
      }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VISIT_NOTE_RESOLVED', entityId: 'n-1' }),
    );
  });

  it('cannot resolve twice, and cannot resolve a plain note', async () => {
    const h1 = build({
      visitNote: {
        findUnique: vi.fn(async () => ({ ...openNote, resolvedAt: new Date() })),
        update: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });
    await expect(h1.service.resolve('n-1', undefined, 'u-adv')).rejects.toThrow(/already/i);

    const h2 = build({
      visitNote: {
        findUnique: vi.fn(async () => ({ ...openNote, requiresAttention: false })),
        update: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });
    await expect(h2.service.resolve('n-1', undefined, 'u-adv')).rejects.toThrow(/does not require/i);
  });
});
