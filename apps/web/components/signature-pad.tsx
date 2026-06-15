'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * CR-2026-034 (C-4) — lightweight canvas signature pad. Emits a base64 PNG data-URL
 * via onChange (null when empty/cleared). Pointer events → touch + mouse friendly.
 */
export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
  }, []);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasInk) setHasInk(true);
  }
  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(hasInk ? canvasRef.current!.toDataURL('image/png') : null);
  }
  function clear() {
    const c = canvasRef.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={400}
        height={140}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="border border-slate-300 rounded-md bg-white w-full"
        style={{ maxWidth: 400, touchAction: 'none' }}
      />
      <button type="button" onClick={clear} className="text-xs text-slate-500 hover:underline mt-1">Clear</button>
    </div>
  );
}
