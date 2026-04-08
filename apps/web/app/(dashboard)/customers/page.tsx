'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

interface CustomerResult {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
}

export default function CustomersPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');

  useEffect(() => {
    if (searchTerm.length < 2) { setDebouncedTerm(''); return; }
    const timer = setTimeout(() => setDebouncedTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const customersQuery = useQuery({
    queryKey: ['customers-list', debouncedTerm],
    queryFn: () => api.get<CustomerResult[]>(`/customers?q=${encodeURIComponent(debouncedTerm)}`),
    enabled: debouncedTerm.length >= 2,
  });

  return (
    <div className="page-container">
      <PageHeader
        title="Customers"
        subtitle="Search and manage customer records"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Customers' },
        ]}
      />

      <div className="mb-6">
        <div className="relative max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search by name, phone, or customer number..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-field pl-10"
          />
        </div>
      </div>

      {debouncedTerm.length < 2 && (
        <EmptyState
          title="Search for customers"
          description="Type at least 2 characters to search customers."
          icon={
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
        />
      )}

      {customersQuery.isLoading && (
        <LoadingState message="Searching..." />
      )}

      {customersQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load customers.</p>
        </div>
      )}

      {customersQuery.data && customersQuery.data.length === 0 && (
        <EmptyState
          title="No customers found"
          description="Try a different search term."
        />
      )}

      {customersQuery.data && customersQuery.data.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Customer #</th>
              </tr>
            </thead>
            <tbody>
              {customersQuery.data.map((c) => (
                <tr key={c.id} className="table-row cursor-pointer">
                  <td>
                    <Link href={`/customers/${c.id}`}
                      className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline">
                      {c.firstName} {c.lastName}
                    </Link>
                    {c.email && <p className="text-xs text-slate-400 mt-0.5">{c.email}</p>}
                  </td>
                  <td className="text-slate-700">{c.phone}</td>
                  <td className="font-mono text-xs text-slate-500">{c.customerNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
