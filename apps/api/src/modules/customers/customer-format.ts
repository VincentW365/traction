/**
 * Customer contact/notes display helpers (CR-2026-021). Pure, I/O-free, testable.
 *
 * - formatPhones: the imported Customer.phone is digits-only and some rows have
 *   MULTIPLE numbers concatenated into one (CSV import bug). This splits clean
 *   multiples into separate readable JM numbers and flags anything ambiguous,
 *   while PRESERVING the raw value (never mutates the DB).
 * - parseCustomerNotes: imported rows store `import:<batchId>; raw="<NAME>"` in
 *   Customer.notes (the import rollback keys on it — never delete it). This splits
 *   that technical metadata away from real staff-entered notes for display.
 *
 * Valid Jamaica number lengths (normalized digits): 7 (local), 10 (876 + 7),
 * 11 (country 1 + 10).
 */

export interface FormattedPhones {
  values: string[]; // formatted, human-readable; [] when none usable
  flagged: boolean; // true when split into multiple OR ambiguous/short
  raw: string; // original stored value, preserved
}

const SEGMENT_LENGTHS = [11, 10, 7];

/** Greedily decompose digits into valid JM-length segments, or null if impossible. */
function decompose(digits: string): string[] | null {
  if (digits.length === 0) return [];
  for (const len of SEGMENT_LENGTHS) {
    if (digits.length >= len) {
      const rest = decompose(digits.slice(len));
      if (rest !== null) return [digits.slice(0, len), ...rest];
    }
  }
  return null;
}

function formatSegment(seg: string): string {
  if (seg.length === 7) return `${seg.slice(0, 3)}-${seg.slice(3)}`;
  if (seg.length === 10) return `${seg.slice(0, 3)}-${seg.slice(3, 6)}-${seg.slice(6)}`;
  if (seg.length === 11) return `${seg.slice(0, 1)} ${seg.slice(1, 4)}-${seg.slice(4, 7)}-${seg.slice(7)}`;
  return seg;
}

export function formatPhones(raw: string | null | undefined): FormattedPhones {
  const original = raw ?? '';
  const digits = original.replace(/\D/g, '');
  if (digits.length < 7) {
    // empty or unusable fragment — never fabricate a number
    return { values: [], flagged: digits.length > 0, raw: original };
  }
  const parts = decompose(digits);
  if (parts === null) {
    // ambiguous length (e.g. 12/13/15 digits) — surface the raw digits, flagged
    return { values: [digits], flagged: true, raw: original };
  }
  return { values: parts.map(formatSegment), flagged: parts.length > 1, raw: original };
}

export interface ParsedNotes {
  staffNotes: string | null; // true customer-facing/staff-entered note
  importMeta: { batchId: string; rawName: string } | null;
  importLine: string | null; // the exact stored import tag line, for verbatim preservation on edit
}

// `import:<batchId>; raw="<NAME>"` written by scripts/import-customers.ts. It occupies
// the FIRST line of notes; any staff-entered note follows on subsequent lines. The
// import rollback matches `notes contains "import:<batchId>"` (a substring), so keeping
// the tag on its own line preserves rollback while allowing editable staff notes below.
const IMPORT_NOTE_RE = /^import:([^;]+);\s*raw="([\s\S]*)"\s*$/;

export function parseCustomerNotes(notes: string | null | undefined): ParsedNotes {
  if (!notes) return { staffNotes: null, importMeta: null, importLine: null };
  const nl = notes.indexOf('\n');
  const firstLine = nl === -1 ? notes : notes.slice(0, nl);
  const rest = nl === -1 ? '' : notes.slice(nl + 1);
  const m = firstLine.match(IMPORT_NOTE_RE);
  if (m) {
    const staff = rest.trim();
    return {
      staffNotes: staff.length ? staff : null,
      importMeta: { batchId: m[1].trim(), rawName: m[2] },
      importLine: firstLine,
    };
  }
  return { staffNotes: notes, importMeta: null, importLine: null };
}

/**
 * Compose the value to STORE in Customer.notes when staff edit the note. Any existing
 * import tag is preserved verbatim on the first line (never deleted — the rollback keys
 * on it); the new staff text follows. Returns null when there is neither.
 */
export function composeCustomerNotes(
  existingNotes: string | null | undefined,
  staffText: string | null | undefined,
): string | null {
  const { importLine } = parseCustomerNotes(existingNotes);
  const staff = (staffText ?? '').trim();
  if (importLine) return staff.length ? `${importLine}\n${staff}` : importLine;
  return staff.length ? staff : null;
}
