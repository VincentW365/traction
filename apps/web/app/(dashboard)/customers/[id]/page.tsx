'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

interface Vehicle {
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
}

interface CustomerDetail {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  notificationOptInSms: boolean;
  notificationOptInEmail: boolean;
  notes: string | null;
  vehicles: Vehicle[];
}

export default function CustomerDetailPage() {
  const params = useParams();
  const customerId = params.id as string;

  const queryClient = useQueryClient();
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [vPlate, setVPlate] = useState('');
  const [vVin, setVVin] = useState('');
  const [vMake, setVMake] = useState('');
  const [vModel, setVModel] = useState('');
  const [vYear, setVYear] = useState('');
  const [vColor, setVColor] = useState('');
  const [vOdometer, setVOdometer] = useState('');

  const { data: customer, isLoading, error } = useQuery<CustomerDetail>({
    queryKey: ['customer', customerId],
    queryFn: () => api.get(`/customers/${customerId}`),
    enabled: !!customerId,
  });

  const addVehicleMutation = useMutation({
    mutationFn: () =>
      api.post('/vehicles', {
        customerId,
        plateNumber: vPlate,
        vin: vVin || undefined,
        make: vMake || undefined,
        model: vModel || undefined,
        modelYear: vYear ? parseInt(vYear, 10) : undefined,
        color: vColor || undefined,
        odometer: vOdometer ? parseInt(vOdometer, 10) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setShowAddVehicle(false);
      setVPlate(''); setVVin(''); setVMake(''); setVModel('');
      setVYear(''); setVColor(''); setVOdometer('');
    },
  });

  if (isLoading) {
    return (
      <div className="page-container">
        <LoadingState message="Loading customer..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader
          title="Customer"
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
        <div className="mt-4">
          <Link href="/customers" className="btn-secondary text-sm">
            Back to Customers
          </Link>
        </div>
      </div>
    );
  }

  if (!customer) return null;

  const fullName = `${customer.firstName} ${customer.lastName}`;

  return (
    <div className="page-container">
      <PageHeader
        title={fullName}
        breadcrumbs={[
          { label: 'Customers', href: '/customers' },
          { label: fullName },
        ]}
        actions={
          <span className="badge bg-slate-100 text-slate-700 font-mono text-xs">
            {customer.customerNumber}
          </span>
        }
      />

      {/* Customer Info Card */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Customer Information</h2>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            <div>
              <div className="input-label">Phone</div>
              <p className="text-sm font-medium text-slate-900">{customer.phone}</p>
            </div>
            <div>
              <div className="input-label">Email</div>
              <p className="text-sm font-medium text-slate-900">{customer.email ?? 'Not provided'}</p>
            </div>
            <div>
              <div className="input-label">SMS Notifications</div>
              <p className="text-sm font-medium text-slate-900">
                {customer.notificationOptInSms ? (
                  <span className="badge bg-emerald-50 text-emerald-700">Opted in</span>
                ) : (
                  <span className="badge bg-slate-100 text-slate-500">Opted out</span>
                )}
              </p>
            </div>
            <div>
              <div className="input-label">Email Notifications</div>
              <p className="text-sm font-medium text-slate-900">
                {customer.notificationOptInEmail ? (
                  <span className="badge bg-emerald-50 text-emerald-700">Opted in</span>
                ) : (
                  <span className="badge bg-slate-100 text-slate-500">Opted out</span>
                )}
              </p>
            </div>
            {customer.notes && (
              <div className="sm:col-span-2">
                <div className="input-label">Notes</div>
                <p className="text-sm text-slate-700">{customer.notes}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Vehicles Section */}
      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Vehicles
            <span className="ml-2 badge bg-slate-100 text-slate-600">{customer.vehicles.length}</span>
          </h2>
          <button onClick={() => setShowAddVehicle(!showAddVehicle)} className={showAddVehicle ? 'text-xs text-slate-500 hover:text-slate-700' : 'text-xs text-blue-600 hover:underline font-medium'}>
            {showAddVehicle ? 'Cancel' : '+ Add Vehicle'}
          </button>
        </div>
        <div className="card-body">
          {showAddVehicle && (
            <div className="mb-4 pb-4 border-b border-slate-100 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <label className="input-label">Plate Number *</label>
                  <input type="text" value={vPlate} onChange={(e) => setVPlate(e.target.value.toUpperCase())} className="input-field" placeholder="e.g., 1234AB" />
                </div>
                <div>
                  <label className="input-label">Make</label>
                  <input type="text" value={vMake} onChange={(e) => setVMake(e.target.value)} className="input-field" placeholder="e.g., Toyota" />
                </div>
                <div>
                  <label className="input-label">Model</label>
                  <input type="text" value={vModel} onChange={(e) => setVModel(e.target.value)} className="input-field" placeholder="e.g., Corolla" />
                </div>
                <div>
                  <label className="input-label">Year</label>
                  <input type="number" value={vYear} onChange={(e) => setVYear(e.target.value)} className="input-field" placeholder="e.g., 2020" />
                </div>
                <div>
                  <label className="input-label">Color</label>
                  <input type="text" value={vColor} onChange={(e) => setVColor(e.target.value)} className="input-field" placeholder="e.g., Silver" />
                </div>
                <div>
                  <label className="input-label">Odometer</label>
                  <input type="number" value={vOdometer} onChange={(e) => setVOdometer(e.target.value)} className="input-field" placeholder="e.g., 45000" />
                </div>
              </div>
              <div>
                <label className="input-label">VIN</label>
                <input type="text" value={vVin} onChange={(e) => setVVin(e.target.value.toUpperCase())} className="input-field" placeholder="Optional" />
              </div>
              {addVehicleMutation.isError && (
                <p className="text-xs text-red-600">{addVehicleMutation.error instanceof Error ? addVehicleMutation.error.message : 'Failed to add vehicle'}</p>
              )}
              <button onClick={() => addVehicleMutation.mutate()} disabled={!vPlate.trim() || addVehicleMutation.isPending} className="btn-primary text-xs">
                {addVehicleMutation.isPending ? 'Adding...' : 'Add Vehicle'}
              </button>
            </div>
          )}

          {customer.vehicles.length === 0 && !showAddVehicle ? (
            <p className="text-sm text-slate-500">No vehicles registered.</p>
          ) : (
            <div className="space-y-3">
              {customer.vehicles.map((v) => (
                <Link
                  key={v.id}
                  href={`/vehicles/${v.id}`}
                  className="block border border-slate-200 rounded-lg p-4 hover:border-blue-300 hover:bg-blue-50/30 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="badge bg-blue-50 text-blue-700 font-mono">
                        {v.vehicleCode || `SC-${v.plateNumber}`}
                      </span>
                      <span className="text-sm font-medium text-slate-900">
                        {[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle'}
                      </span>
                    </div>
                    {v.weightClass && (
                      <span className="badge bg-slate-100 text-slate-600">{v.weightClass}</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                    <span>Plate: <span className="font-medium text-slate-700">{v.plateNumber}</span></span>
                    {v.vin && <span>VIN: <span className="font-medium text-slate-700">{v.vin}</span></span>}
                    {v.odometer != null && <span>Odometer: <span className="font-medium text-slate-700">{v.odometer.toLocaleString()} mi</span></span>}
                    {v.color && <span>Color: <span className="font-medium text-slate-700">{v.color}</span></span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-3">
        <Link href="/check-in" className="btn-primary">
          Check In This Customer
        </Link>
        <Link href="/appointments/new" className="btn-secondary">
          Book Appointment
        </Link>
      </div>
    </div>
  );
}
