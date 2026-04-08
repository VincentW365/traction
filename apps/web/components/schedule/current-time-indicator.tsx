'use client';

import { useState, useEffect } from 'react';

interface Props {
  openMinutes: number;
  closeMinutes: number;
  pxPerMinute: number;
  isToday: boolean;
}

export function CurrentTimeIndicator({ openMinutes, closeMinutes, pxPerMinute, isToday }: Props) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    if (!isToday) return;
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, [isToday]);

  if (!isToday) return null;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (currentMinutes < openMinutes || currentMinutes > closeMinutes) return null;

  const left = (currentMinutes - openMinutes) * pxPerMinute;

  return (
    <div className="absolute top-0 bottom-0 z-[15] pointer-events-none" style={{ left: `${left}px` }}>
      <div className="w-px h-full bg-red-500" />
      <div className="absolute -top-0.5 -left-1 w-2 h-2 rounded-full bg-red-500" />
    </div>
  );
}
