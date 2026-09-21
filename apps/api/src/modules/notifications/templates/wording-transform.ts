/**
 * CR-2026-114 §8 — safe terminology changes in template wording.
 *
 * The bug this exists to prevent, found in CR-2026-113's own tooling: a
 * word-level "Pickup → Collection" replacement rewrote `{{pickupDetails}}` to
 * `{{collectionDetails}}`. No customer would have seen it — the renderer drops
 * a token it cannot fill — but the placeholder allow-list would have rejected
 * the template the next time a manager tried to save it. A wording change had
 * quietly broken the template's *vocabulary*.
 *
 * The rule: **template variables are a registered vocabulary, not prose.**
 * Anything inside `{{ … }}` is left byte-for-byte alone. Renaming one is a
 * deliberate migration of the placeholder allow-list and every template that
 * uses it — never a side effect of changing the words around it.
 */

/** Splits on placeholders, keeping them, so prose and vocabulary stay separate. */
const PLACEHOLDER_SPLIT = /(\{\{[^}]*\}\})/g;

export function isPlaceholderToken(part: string): boolean {
  return part.startsWith('{{') && part.endsWith('}}');
}

/**
 * Apply a prose transformation to template text, leaving every `{{token}}`
 * untouched.
 */
export function transformWording(text: string, transform: (prose: string) => string): string {
  return text
    .split(PLACEHOLDER_SPLIT)
    .map((part) => (isPlaceholderToken(part) ? part : transform(part)))
    .join('');
}

/** "Pickup" → "Collection", preserving sentence case. Prose only. */
export function pickupToCollection(text: string): string {
  return transformWording(text, (prose) =>
    prose.replace(/Pickup/g, 'Collection').replace(/pickup/g, 'collection'),
  );
}

/** The placeholder names a piece of text uses, for before/after comparison. */
export function placeholdersIn(text: string): string[] {
  return text.split(PLACEHOLDER_SPLIT).filter(isPlaceholderToken);
}

/**
 * A guard any wording migration can assert on: the vocabulary must be identical
 * before and after. Returns the tokens that changed, which is empty when the
 * transformation only touched prose.
 */
export function placeholderDrift(before: string, after: string): { removed: string[]; added: string[] } {
  const b = placeholdersIn(before);
  const a = placeholdersIn(after);
  return {
    removed: b.filter((t) => !a.includes(t)),
    added: a.filter((t) => !b.includes(t)),
  };
}
