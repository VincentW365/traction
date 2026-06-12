'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

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

  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [editMake, setEditMake] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editYear, setEditYear] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editOdometer, setEditOdometer] = useState('');
  const [editVin, setEditVin] = useState('');

  const { data: vehicle, isLoading, error } = useQuery<VehicleDetail>({
    queryKey: ['vehicle', vehicleId],
    queryFn: () => api.get(`/vehicles/${vehicleId}`),
    enabled: !!vehicleId,
  });

  const editMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.patch(`/vehicles/${vehicleId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle', vehicleId] });
      setIsEditing(false);
    },
  });

  function startEdit() {
    if (!vehicle) return;
    setEditMake(vehicle.make ?? '');
    setEditModel(vehicle.model ?? '');
    setEditYear(vehicle.modelYear?.toString() ?? '');
    setEditColor(vehicle.color ?? '');
    setEditOdometer(vehicle.odometer?.toString() ?? '');
    setEditVin(vehicle.vin ?? '');
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
    });
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
            <span className="badge bg-blue-50 text-blue-700 font-mono">
              {vehicle.vehicleCode || `SC-${vehicle.plateNumber}`}
            </span>
            {!isEditing && (
              <button onClick={startEdit} className="btn-secondary text-xs">Edit</button>
            )}
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
                  <div className="input-label">Plate Number</div>
                  <p className="text-sm font-medium text-slate-900">{vehicle.plateNumber}</p>
                </div>
                <div>
                  <label className="input-label">VIN</label>
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
                <div className="input-label">Plate Number</div>
                <p className="text-sm font-medium text-slate-900">{vehicle.plateNumber}</p>
              </div>
              <div>
                <div className="input-label">VIN</div>
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

      {/* Quick Actions */}
      <div className="flex items-center gap-3">
        <Link href="/check-in" className="btn-primary">
          Check In
        </Link>
        <Link href="/appointments/new" className="btn-secondary">
          Schedule Appointment
        </Link>
      </div>
    </div>
  );
}
