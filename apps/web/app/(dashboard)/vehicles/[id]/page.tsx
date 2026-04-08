'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/page-header';
import { LoadingState } from '../../../../components/loading-state';

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

  const { data: vehicle, isLoading, error } = useQuery<VehicleDetail>({
    queryKey: ['vehicle', vehicleId],
    queryFn: () => api.get(`/vehicles/${vehicleId}`),
    enabled: !!vehicleId,
  });

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
          <span className="badge bg-blue-50 text-blue-700 font-mono">
            {vehicle.vehicleCode || `SC-${vehicle.plateNumber}`}
          </span>
        }
      />

      {/* Vehicle Info Card */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Vehicle Information</h2>
        </div>
        <div className="card-body">
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
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-3">
        <Link href="/check-in" className="btn-primary">
          Check In
        </Link>
        <Link href="/appointments/new" className="btn-secondary">
          Book Appointment
        </Link>
      </div>
    </div>
  );
}
