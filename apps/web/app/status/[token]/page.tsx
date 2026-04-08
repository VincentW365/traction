'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

interface CustomerStatus {
  ticketNumber: string | null;
  position: number | null;
  status: string;
  partsReadiness: string;
  estimatedWait: string;
  services: string[];
  vehiclePlate: string;
  statusProgression: string[];
  currentStep: number;
}

const STEP_LABELS = ['Checked In', 'In Queue', 'Called', 'In Service', 'Ready'];

function StepCircle({ index, currentStep, isReady }: { index: number; currentStep: number; isReady: boolean }) {
  const isCompleted = index < currentStep;
  const isActive = index === currentStep;
  const isFinal = isReady && index === 4;

  let classes = 'w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-all ';
  if (isFinal || (isCompleted && isReady)) {
    classes += 'bg-emerald-500 text-white';
  } else if (isCompleted || isActive) {
    classes += 'bg-blue-600 text-white';
  } else {
    classes += 'bg-slate-200 text-slate-400';
  }

  return (
    <div className={classes}>
      {isCompleted || isActive ? (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        index + 1
      )}
    </div>
  );
}

export default function CustomerStatusPage() {
  const params = useParams();
  const token = params.token as string;

  const { data, isLoading, error } = useQuery<CustomerStatus>({
    queryKey: ['customer-status', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/status/${token}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error('EXPIRED');
        throw new Error('Failed to load status');
      }
      return res.json();
    },
    refetchInterval: 15000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center flex-col gap-4">
        <div className="flex justify-center">
          <img src="/brand-mark.png" alt="Bert's Auto Parts" className="h-8 w-auto object-contain" />
        </div>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" />
          <span className="text-sm text-slate-500">Loading your status...</span>
        </div>
      </div>
    );
  }

  if (error) {
    const isExpired = (error as Error).message === 'EXPIRED';
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-8 max-w-sm w-full text-center">
          <div className="flex items-center justify-center gap-2 mb-5">
            <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">T</span>
            </div>
            <span className="text-sm font-bold text-slate-700 tracking-tight">Traction</span>
          </div>
          <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${isExpired ? 'bg-amber-50' : 'bg-red-50'}`}>
            <svg className={`w-6 h-6 ${isExpired ? 'text-amber-500' : 'text-red-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isExpired ? 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' : 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z'} />
            </svg>
          </div>
          <h1 className="text-lg font-bold text-slate-900 mb-2">
            {isExpired ? 'Link Expired' : 'Something Went Wrong'}
          </h1>
          <p className="text-sm text-slate-500 leading-relaxed">
            {isExpired
              ? 'This status link has expired. Please contact the front desk for an update.'
              : 'Unable to load your vehicle status. Please try again or contact the front desk.'}
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const isReady = data.currentStep >= 4;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 md:py-10">
      <div className="max-w-md mx-auto space-y-5">
        {/* Brand */}
        <div className="flex items-center justify-center gap-2">
          <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">T</span>
          </div>
          <span className="text-sm font-bold text-slate-700 tracking-tight">Traction</span>
        </div>

        {/* Ticket Info Card */}
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6 text-center">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Your Ticket</div>
          <div className="text-3xl font-bold text-blue-600">{data.ticketNumber ?? '--'}</div>
          <div className="text-sm text-slate-500 mt-1 font-mono">{data.vehiclePlate}</div>
        </div>

        {/* Progress Stepper */}
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
          {/* Step circles with connecting bars */}
          <div className="flex items-center justify-between relative">
            {/* Background bar */}
            <div className="absolute top-[18px] left-[18px] right-[18px] h-1 bg-slate-200 rounded-full" />
            {/* Filled bar */}
            <div
              className={`absolute top-[18px] left-[18px] h-1 rounded-full transition-all duration-500 ${isReady ? 'bg-emerald-500' : 'bg-blue-600'}`}
              style={{ width: `calc(${(Math.min(data.currentStep, 4) / 4) * 100}% - ${data.currentStep === 0 ? 0 : 0}px)` }}
            />
            {STEP_LABELS.map((label, idx) => (
              <div key={label} className="flex flex-col items-center z-10">
                <StepCircle index={idx} currentStep={data.currentStep} isReady={isReady} />
                <span className={`text-[10px] mt-2 text-center leading-tight font-medium ${
                  idx <= data.currentStep
                    ? isReady ? 'text-emerald-700' : 'text-blue-700'
                    : 'text-slate-400'
                }`}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ETA / Status Message */}
        <div className={`rounded-lg border shadow-sm p-6 text-center ${
          isReady
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-white border-slate-200'
        }`}>
          <div className={`text-xl font-bold ${isReady ? 'text-emerald-700' : 'text-slate-800'}`}>
            {data.estimatedWait}
          </div>
          {data.position !== null && !isReady && (
            <div className="text-sm text-slate-500 mt-2">
              You are <span className="font-bold text-blue-600">#{data.position}</span> in line
            </div>
          )}
        </div>

        {/* Services */}
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-5">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Services</div>
          <ul className="space-y-2">
            {data.services.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-slate-700">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                {s}
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-slate-400 pb-4">
          Auto-refreshes every 15 seconds
        </div>
      </div>
    </div>
  );
}
