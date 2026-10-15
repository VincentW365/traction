'use client';

import { useEffect } from 'react';

/**
 * CR-2026-118 §4E — do not let a form's unsaved work vanish on navigation.
 *
 * The inspection forms track `dirty` but only saved it on Complete. A tab close,
 * a browser Back, or the new "Back to Job" link would drop every unsaved tick
 * without a word. Two guards, deliberately small:
 *
 *  - `beforeunload` while dirty, for reloads, closes and hard navigations. The
 *    browser shows its own generic prompt; the text cannot be customised.
 *  - A shared "anything dirty?" flag the page-level back link consults, for
 *    client-side navigation, which `beforeunload` never sees.
 *
 * Module-level state is intentional: the dirty flag lives in a tab component,
 * the back link lives in the page header, and threading a prop through every
 * tab for one boolean would be worse than one shared ref.
 */

const dirtyOwners = new Set<symbol>();

export function anyUnsavedChanges(): boolean {
  return dirtyOwners.size > 0;
}

/** Register this component's dirty state for as long as it is mounted. */
export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const owner = Symbol('dirty');
    dirtyOwners.add(owner);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers read returnValue; modern ones ignore the text.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      dirtyOwners.delete(owner);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}

/**
 * For a client-side link out of a form: returns true when it is fine to leave.
 * Asks only when something is actually unsaved, so the common case costs nothing.
 */
export function confirmLeave(): boolean {
  if (!anyUnsavedChanges()) return true;
  return window.confirm('You have unsaved changes on this form. Leave without saving?');
}
