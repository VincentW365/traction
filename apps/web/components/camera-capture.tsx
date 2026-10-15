'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * CR-2026-118 §3 — photographs from a workshop tablet, done properly.
 *
 * What was wrong: every photo control was a hidden `<input type="file"
 * capture="environment">`. The `capture` attribute is a HINT. iPad Safari
 * honours it; Chrome on Android tablets, Chrome on iPad, Samsung Internet and
 * most kiosk/webview browsers treat it as an ordinary file picker, which is
 * exactly the "behaves like a desktop" report. There was also no preview: the
 * first file chosen was uploaded immediately, so a blurry or sideways shot
 * went straight onto the record.
 *
 * What this does instead, in order of preference:
 *
 *  1. Live camera through `getUserMedia` (rear camera first, front/rear switch
 *     when the device has both), with a shutter button and a real preview.
 *     Requires a secure context — HTTPS, or localhost. On a plain-http LAN
 *     address the browser refuses before asking, and the component says so.
 *  2. The `capture` input as the fallback — on the browsers that honour it this
 *     still opens the camera app; on the rest it is at least the gallery.
 *  3. "Upload existing photo" is a separate action with no `capture` hint, so
 *     the two never get confused for one another.
 *
 * Every path ends at the same confirmation: RETAKE | USE PHOTO | CANCEL.
 * Nothing is uploaded until the person has looked at it.
 *
 * Orientation is baked into the pixels here, on the device, with
 * `createImageBitmap(file, { imageOrientation: 'from-image' })`. The server
 * strips EXIF for privacy and has no column for the orientation tag it reads,
 * so a portrait phone photo arrived sideways. Rotating before upload makes the
 * strip harmless and needs no schema change. The same pass downscales to a
 * sensible longest edge: photos are stored in Postgres, not an object store,
 * and a 12 MP original would bloat every read of the record.
 *
 * Emits a JPEG `File`, because that is what the multipart upload endpoint
 * takes. Reusable by any form that attaches photographs.
 */

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

type Stage = 'idle' | 'live' | 'preview';
type Facing = 'environment' | 'user';

export interface CameraCaptureProps {
  /** Receives the confirmed photo. Reject to keep the preview open with the error. */
  onCapture: (file: File) => Promise<unknown> | unknown;
  disabled?: boolean;
  /** Shown while onCapture is running. */
  busyLabel?: string;
  takeLabel?: string;
  uploadLabel?: string;
  className?: string;
}

function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function secureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext;
}

/** Why the live camera cannot be used, in words someone can act on. */
export function explainCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access was blocked. Allow the camera for this site in the browser settings, then try again — or use Upload existing photo.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device. Use Upload existing photo instead.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is in use by another app. Close it and try again.';
    case 'OverconstrainedError':
      return 'The requested camera is not available on this device.';
    default:
      return 'The camera could not be started. Use Upload existing photo instead.';
  }
}

/**
 * Bake orientation, downscale, and encode as JPEG — on the device, before upload.
 */
async function normaliseImage(source: Blob, filename: string): Promise<File> {
  // `imageOrientation: 'from-image'` applies the EXIF rotation into the pixels.
  // Older engines ignore the option; the photo is then exactly as before, never worse.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    bitmap = await createImageBitmap(source);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This device could not process the photo.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('This device could not encode the photo.'))), 'image/jpeg', JPEG_QUALITY),
  );
  return new File([blob], filename.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

export function CameraCapture({
  onCapture,
  disabled,
  busyLabel = 'Saving…',
  takeLabel = 'Take Picture',
  uploadLabel = 'Upload existing photo',
  className,
}: CameraCaptureProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [facing, setFacing] = useState<Facing>('environment');
  const [canFlip, setCanFlip] = useState(false);
  const [preview, setPreview] = useState<{ url: string; file: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which fallback the Retake button should reopen, when the live camera was not used. */
  const [retakeVia, setRetakeVia] = useState<'live' | 'capture' | 'upload'>('live');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Never leave a camera running after the component is gone.
  useEffect(() => () => { stopStream(); if (preview) URL.revokeObjectURL(preview.url); }, [stopStream, preview]);

  const startLive = useCallback(async (which: Facing) => {
    setError(null);
    stopStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: which }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setStage('live');
      // Attach after the <video> has rendered.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      });
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
      } catch {
        setCanFlip(false);
      }
    } catch (err) {
      stopStream();
      setStage('idle');
      setError(explainCameraError(err));
      // Permission or hardware problems: hand over to the capture input, which
      // may still reach the native camera app on this browser.
      if ((err as { name?: string })?.name !== 'NotAllowedError') captureInputRef.current?.click();
    }
  }, [stopStream]);

  const takePicture = () => {
    if (disabled || busy) return;
    if (cameraAvailable() && secureContext()) {
      setRetakeVia('live');
      void startLive(facing);
      return;
    }
    // No live camera possible here. Say why only when it is the connection, which
    // is the one cause a manager can fix.
    if (cameraAvailable() && !secureContext()) {
      setError('The live camera needs a secure (https) connection. Opening the device camera instead.');
    }
    setRetakeVia('capture');
    captureInputRef.current?.click();
  };

  const shutter = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    stopStream();
    if (!blob) { setError('The photo could not be captured. Try again.'); setStage('idle'); return; }
    await showPreview(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
  };

  const showPreview = async (raw: File) => {
    setError(null);
    setBusy(true);
    try {
      const file = await normaliseImage(raw, raw.name || 'photo.jpg');
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ url: URL.createObjectURL(file), file });
      setStage('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That photo could not be used.');
      setStage('idle');
    } finally {
      setBusy(false);
    }
  };

  const onFileChosen = (via: 'capture' | 'upload') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Always clear, so choosing the SAME file again still fires a change event.
    e.target.value = '';
    if (!file) return;
    setRetakeVia(via);
    await showPreview(file);
  };

  const usePhoto = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await onCapture(preview.file);
      URL.revokeObjectURL(preview.url);
      setPreview(null);
      setStage('idle');
    } catch (err) {
      // Keep the preview: the person should not have to take the photo again
      // because the network dropped.
      setError(err instanceof Error ? err.message : 'The photo could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const retake = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setError(null);
    if (retakeVia === 'live') void startLive(facing);
    else if (retakeVia === 'capture') { setStage('idle'); captureInputRef.current?.click(); }
    else { setStage('idle'); uploadInputRef.current?.click(); }
  };

  const cancel = () => {
    stopStream();
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setError(null);
    setStage('idle');
  };

  const flip = () => {
    const next: Facing = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    void startLive(next);
  };

  return (
    <div className={className}>
      {/* The two hidden inputs — one with the capture hint, one deliberately without. */}
      <input ref={captureInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChosen('capture')} />
      <input ref={uploadInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onFileChosen('upload')} />

      {stage === 'idle' && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={takePicture} disabled={disabled || busy} className="btn-primary text-xs">
            {busy ? busyLabel : takeLabel}
          </button>
          <button type="button" onClick={() => { setRetakeVia('upload'); uploadInputRef.current?.click(); }} disabled={disabled || busy} className="btn-secondary text-xs">
            {uploadLabel}
          </button>
        </div>
      )}

      {stage === 'live' && (
        <div className="rounded-lg overflow-hidden bg-black">
          <video ref={videoRef} playsInline muted autoPlay className="w-full max-h-[70vh] object-contain bg-black" />
          <div className="flex items-center justify-between gap-2 p-2 bg-slate-900">
            <button type="button" onClick={cancel} className="btn-secondary text-xs">Cancel</button>
            <button
              type="button"
              onClick={() => void shutter()}
              aria-label="Capture photo"
              className="h-14 w-14 rounded-full bg-white ring-4 ring-slate-400 active:scale-95"
            />
            {canFlip ? (
              <button type="button" onClick={flip} className="btn-secondary text-xs">Flip camera</button>
            ) : (
              <span className="w-[88px]" />
            )}
          </div>
        </div>
      )}

      {stage === 'preview' && preview && (
        <div className="rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview.url} alt="Captured photo, awaiting confirmation" className="w-full max-h-[70vh] object-contain bg-black" />
          <div className="grid grid-cols-3 gap-2 p-2">
            <button type="button" onClick={retake} disabled={busy} className="btn-secondary text-xs">Retake</button>
            <button type="button" onClick={() => void usePhoto()} disabled={busy} className="btn-primary text-xs">
              {busy ? busyLabel : 'Use Photo'}
            </button>
            <button type="button" onClick={cancel} disabled={busy} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 mt-1.5" role="alert">{error}</p>}
    </div>
  );
}
