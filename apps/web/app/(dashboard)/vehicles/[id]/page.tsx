'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { CustomerNotificationComposer } from '../../../../components/notification-composer';
import { CommunicationHistory } from '../../../../components/communication-history';
import { VisitHistory } from '../../../../components/visit-history';

interface VehicleDetail {
  id: string;
  vehicleCode: string;
  plateNumber: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  color: string | null;
  odometer: number | null;
  weightClass: string | null;
  // CR-2026-100 §10 — the ONE authoritative vehicle classification.
  serviceClass: 'SEDAN_CLASS' | 'SUV_CLASS' | 'UNKNOWN_REQUIRES_REVIEW' | null;
  fuelType: string | null;
  transmission: string | null;
  drivetrain: string | null;
  engineNo: string | null;
  driveSide: 'RHD' | 'LHD' | null;
  customer: {
    id: string;
    customerNumber: string;
    firstName: string;
    lastName: string;
    phone: string;
  };
}

export default function VehicleDetailPage() {
  const params = useParams();
  const vehicleId = params.id as string;
  // CR-2026-102 §12 — this is the vehicle ADMINISTRATION screen. A technician
  // landing here (old link, typed URL) gets a clean redirect to the
  // technician-safe view of the same vehicle, not a raw permission error.
  const { user } = useAuth();
  const isTechnician = user?.roleCode === 'TECHNICIAN';

  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [editMake, setEditMake] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editYear, setEditYear] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editOdometer, setEditOdometer] = useState('');
  const [editVin, setEditVin] = useState('');
  const [editTransmission, setEditTransmission] = useState('');
  const [editDrivetrain, setEditDrivetrain] = useState('');
  const [editFuelType, setEditFuelType] = useState('');
  const [editEngineNo, setEditEngineNo] = useState('');
  const [editDriveSide, setEditDriveSide] = useState('');

  const { data: vehicle, isLoading, error } = useQuery<VehicleDetail>({
    queryKey: ['vehicle', vehicleId],
    queryFn: () => api.get(`/vehicles/${vehicleId}`),
    // Never fire the admin read for a technician — their view is elsewhere.
    enabled: !!vehicleId && !isTechnician,
  });

  const editMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patch(`/vehicles/${vehicleId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
      setIsEditing(false);
    },
  });

  // CR-2026-100 §10 — deliberate, audited correction of the vehicle type. The
  // class lives ON the vehicle record (one authoritative copy) and flows from
  // here through queue, dispatch, technician view, job sheet and KPI reporting.
  const [changingClass, setChangingClass] = useState(false);
  const [newClass, setNewClass] = useState('');
  const classMutation = useMutation({
    mutationFn: () =>
      api.post(`/vehicles/classification/${vehicleId}/confirm`, { serviceClass: newClass }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
      setChangingClass(false);
      setNewClass('');
    },
  });
  const classLabel =
    vehicle?.serviceClass === 'SEDAN_CLASS' ? 'Sedan'
      : vehicle?.serviceClass === 'SUV_CLASS' ? 'SUV'
        : vehicle?.serviceClass === 'UNKNOWN_REQUIRES_REVIEW' ? 'Needs review'
          : 'Not set';

  function startEdit() {
    if (!vehicle) return;
    setEditMake(vehicle.make ?? '');
    setEditModel(vehicle.model ?? '');
    setEditYear(vehicle.modelYear?.toString() ?? '');
    setEditColor(vehicle.color ?? '');
    setEditOdometer(vehicle.odometer?.toString() ?? '');
    setEditVin(vehicle.vin ?? '');
    setEditTransmission(vehicle.transmission ?? '');
    setEditDrivetrain(vehicle.drivetrain ?? '');
    setEditFuelType(vehicle.fuelType ?? '');
    setEditEngineNo(vehicle.engineNo ?? '');
    setEditDriveSide(vehicle.driveSide ?? '');
    setIsEditing(true);
  }

  function saveEdit() {
    editMutation.mutate({
      make: editMake || undefined,
      model: editModel || undefined,
      modelYear: editYear ? parseInt(editYear, 10) : undefined,
      color: editColor || undefined,
      odometer: editOdometer ? parseInt(editOdometer, 10) : undefined,
      vin: editVin || undefined,
      transmission: editTransmission || undefined,
      drivetrain: editDrivetrain || undefined,
      fuelType: editFuelType || undefined,
      engineNo: editEngineNo || undefined,
      driveSide: editDriveSide || undefined,
    });
  }

  if (isTechnician) {
    return (
      <div className="page-container">
        <PageHeader title="Vehicle" breadcrumbs={[{ label: 'My Jobs', href: '/technician' }, { label: 'Vehicle' }]} />
        <div className="card p-6 text-center border-blue-200 bg-blue-50">
          <p className="text-sm text-blue-900">
            This is the vehicle administration screen. Your read-only vehicle view has everything you
            need for the job.
          </p>
          <Link
            href={`/technician/vehicles/${vehicleId}`}
            className="btn-primary text-sm inline-block mt-3"
          >
            Open Vehicle (technician view)
          </Link>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="page-container">
        <LoadingState message="Loading vehicle..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader
          title="Vehicle"
          breadcrumbs={[
            { label: 'Customers', href: '/customers' },
            { label: 'Error' },
          ]}
        />
        <div className="card">
          <div className="card-body">
            <div className="flex items-center gap-3 text-red-700">
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{(error as Error).message}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!vehicle) return null;

  const ownerName = `${vehicle.customer.firstName} ${vehicle.customer.lastName}`;
  const vehicleTitle = [vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle';

  return (
    <div className="page-container">
      <PageHeader
        title={vehicleTitle}
        breadcrumbs={[
          { label: 'Customers', href: '/customers' },
          { label: ownerName, href: `/customers/${vehicle.customer.id}` },
          { label: vehicle.plateNumber },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <span className="badge bg-blue-50 text-blue-700 font-mono" title="Service Centre ID">
              {vehicle.vehicleCode || `SC${vehicle.plateNumber}`}
            </span>
            {!isEditing && (
              <button onClick={startEdit} className="btn-secondary text-xs">Edit</button>
            )}
            <button onClick={() => setShowComposer(true)} className="btn-primary text-xs">Contact Customer</button>
          </div>
        }
      />

      {/* Vehicle Info Card */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Vehicle Information</h2>
        </div>
        <div className="card-body">
          {isEditing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                <div>
                  <div className="input-label">Service Centre ID</div>
                  <p className="text-sm font-mono font-medium text-slate-900">{vehicle.vehicleCode}</p>
                </div>
                <div>
                  <div className="input-label">Plate Number</div>
                  <p className="text-sm font-medium text-slate-900">{vehicle.plateNumber}</p>
                </div>
                <div>
                  <label className="input-label">Chassis Number/VIN</label>
                  <input type="text" value={editVin} onChange={(e) => setEditVin(e.target.value.toUpperCase())} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Make</label>
                  <input type="text" value={editMake} onChange={(e) => setEditMake(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Model</label>
                  <input type="text" value={editModel} onChange={(e) => setEditModel(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Year</label>
                  <input type="number" value={editYear} onChange={(e) => setEditYear(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Color</label>
                  <input type="text" value={editColor} onChange={(e) => setEditColor(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Odometer</label>
                  <input type="number" value={editOdometer} onChange={(e) => setEditOdometer(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Transmission</label>
                  <input type="text" value={editTransmission} onChange={(e) => setEditTransmission(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Drivetrain</label>
                  <input type="text" value={editDrivetrain} onChange={(e) => setEditDrivetrain(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Fuel Type</label>
                  <input type="text" value={editFuelType} onChange={(e) => setEditFuelType(e.target.value)} className="input-field" />
                </div>
                <div>
                  <label className="input-label">Drive Side</label>
                  <select value={editDriveSide} onChange={(e) => setEditDriveSide(e.target.value)} className="input-field">
                    <option value="">Unknown</option>
                    <option value="RHD">Right-hand drive (RHD)</option>
                    <option value="LHD">Left-hand drive (LHD)</option>
                  </select>
                </div>
                <div>
                  <label className="input-label">Engine No <span className="text-[10px] text-slate-400 font-normal">(staff only)</span></label>
                  <input type="text" value={editEngineNo} onChange={(e) => setEditEngineNo(e.target.value)} className="input-field" />
                </div>
                <div>
                  <div className="input-label">Owner</div>
                  <p className="text-sm font-medium">
                    <Link href={`/customers/${vehicle.customer.id}`} className="text-blue-600 hover:underline">{ownerName}</Link>
                  </p>
                </div>
              </div>
              {editMutation.isError && (
                <p className="text-xs text-red-600">{editMutation.error instanceof Error ? editMutation.error.message : 'Failed to save'}</p>
              )}
              <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
                <button onClick={saveEdit} disabled={editMutation.isPending} className="btn-primary text-xs">
                  {editMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
                <button onClick={() => setIsEditing(false)} className="btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <div className="input-label">Service Centre ID</div>
                <p className="text-sm font-mono font-medium text-slate-900">{vehicle.vehicleCode}</p>
              </div>
              <div>
                <div className="input-label">Plate Number</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.plateNumber}</p>
              </div>
              <div>
                <div className="input-label">Chassis Number/VIN</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.vin ?? 'Not recorded'}</p>
              </div>
              <div>
                <div className="input-label">Color</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.color ?? '--'}</p>
              </div>
              <div>
                <div className="input-label">Odometer</div>
                <p className="text-sm font-medium text-slate-900">
                  {vehicle.odometer != null ? `${vehicle.odometer.toLocaleString()} mi` : '--'}
                </p>
              </div>
              <div>
                <div className="input-label">Weight Class</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.weightClass ?? 'Not set'}</p>
              </div>
              <div>
                <div className="input-label">Vehicle Type (Sedan / SUV)</div>
                {changingClass ? (
                  <div className="flex items-center gap-2 mt-0.5">
                    <select value={newClass} onChange={(e) => setNewClass(e.target.value)} className="input-field text-xs w-auto">
                      <option value="">Choose…</option>
                      <option value="SEDAN_CLASS">Sedan</option>
                      <option value="SUV_CLASS">SUV</option>
                    </select>
                    <button
                      onClick={() => classMutation.mutate()}
                      disabled={!newClass || classMutation.isPending}
                      className="btn-primary text-xs px-2 py-1"
                    >
                      {classMutation.isPending ? 'Saving…' : 'Save (audited)'}
                    </button>
                    <button onClick={() => setChangingClass(false)} className="btn-secondary text-xs px-2 py-1">Cancel</button>
                  </div>
                ) : (
                  <p className="text-sm font-medium text-slate-900">
                    {classLabel}
                    <button
                      onClick={() => { setChangingClass(true); setNewClass(vehicle.serviceClass && vehicle.serviceClass !== 'UNKNOWN_REQUIRES_REVIEW' ? vehicle.serviceClass : ''); }}
                      className="text-xs text-blue-600 hover:underline ml-2"
                    >
                      {vehicle.serviceClass ? 'Correct' : 'Set'}
                    </button>
                  </p>
                )}
                {classMutation.isError && (
                  <p className="text-xs text-red-600 mt-0.5">{classMutation.error instanceof Error ? classMutation.error.message : 'Failed to save'}</p>
                )}
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Saved to the vehicle record and used everywhere — queue, dispatch, job sheet, KPI standards.
                </p>
              </div>
              <div>
                <div className="input-label">Transmission</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.transmission ?? '--'}</p>
              </div>
              <div>
                <div className="input-label">Drivetrain</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.drivetrain ?? '--'}</p>
              </div>
              <div>
                <div className="input-label">Fuel Type</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.fuelType ?? '--'}</p>
              </div>
              <div>
                <div className="input-label">Drive Side</div>
                <p className="text-sm font-medium text-slate-900">
                  {vehicle.driveSide === 'RHD'
                    ? 'Right-hand drive (RHD)'
                    : vehicle.driveSide === 'LHD'
                      ? 'Left-hand drive (LHD)'
                      : 'Not recorded'}
                </p>
              </div>
              <div>
                <div className="input-label">Engine No <span className="text-[10px] text-slate-400 font-normal">(staff only)</span></div>
                <p className="text-sm font-medium text-slate-900">{vehicle.engineNo ?? 'Not recorded'}</p>
              </div>
              <div>
                <div className="input-label">Owner</div>
                <p className="text-sm font-medium">
                  <Link href={`/customers/${vehicle.customer.id}`} className="text-blue-600 hover:underline">
                    {ownerName}
                  </Link>
                  <span className="text-slate-400 ml-1.5 text-xs font-mono">({vehicle.customer.customerNumber})</span>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CR-2026-097 — this vehicle's complete visit history, each row → Visit Record */}
      <div className="mb-6">
        <VisitHistory customerId={vehicle.customer.id} vehicleId={vehicle.id} />
      </div>

      {/* CR-2026-096 — messages sent about THIS vehicle (service-history context) */}
      <div className="mb-6">
        <CommunicationHistory vehicleId={vehicle.id} />
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-3">
        <Link href="/check-in" className="btn-primary">
          Check In
        </Link>
        {/* CR-2026-106 — deep link carries BOTH ids so the wizard opens on the service step for this car */}
        <Link href={`/appointments/new?customerId=${vehicle.customer.id}&vehicleId=${vehicle.id}`} className="btn-secondary">
          Schedule Appointment
        </Link>
      </div>

      {showComposer && (
        <CustomerNotificationComposer
          open
          context={{ reason: 'CUSTOM', customerId: vehicle.customer.id, vehicleId: vehicle.id }}
          onClose={() => setShowComposer(false)}
        />
      )}
    </div>
  );
}
