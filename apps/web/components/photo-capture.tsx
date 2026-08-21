'use client';

import { useRef, useState } from 'react';

/**
 * CR-2026-087 — pre-inspection vehicle photo capture, for a technician's tablet.
 *
 * `capture="environment"` makes a tablet or phone open the rear camera directly
 * rather than a file browser; on a desktop the same input is an ordinary file
 * picker, so the component works in both places.
 *
 * The downscale is the important part, not a nicety. Photos are stored as base64
 * in Postgres (there is no object store in this deployment and Render's free plan
 * has no persistent disk), so a raw 1–5 MB camera image would bloat every read of
 * the row and exceed the request body limit. Resizing to a longest edge of 1280px
 * as JPEG lands around 150–300 kB, which is plenty to see a scuff or a cracked
 * lens, and happens on the device so the large original never crosses the network.
 */

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.7;

async function downscaleToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the photo on this device.');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

interface PhotoCaptureProps {
  onCapture: (imageData: string) => Promise<unknown> | unknown;
  disabled?: boolean;
  label?: string;
}

export function PhotoCapture({ onCapture, disabled, label = 'Add photo' }: PhotoCaptureProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Always clear the input, so retaking the SAME file still fires a change event.
    e.target.value = '';
    if (!file) return;

    setError(null);
    setBusy(true);
    try {
      const dataUrl = await downscaleToDataUrl(file);
      await onCapture(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that photo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || busy}
        className="btn-secondary text-sm"
      >
        {busy ? 'Adding…' : label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
    </div>
  );
}
