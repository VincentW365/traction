'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

// CR-2026-021: privacy-safe list shape — NO phone is ever returned in lists.
interface CustomerListItem {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  hasLoyalty: boolean;
  vehicleCount: number;
  lastVisitAt: string | null;
  missingContact: boolean;
}
interface DirectoryResponse {
  items: CustomerListItem[];
  total: number;
  limit: number;
  offset: number;
}

const DIRECTORY_ROLES = ['ADMIN', 'MANAGER'];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const PAGE_SIZE = 50;

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function LoyaltyBadge({ on }: { on: boolean }) {
  return on ? (
    <span className="badge bg-amber-50 text-amber-700">★ Loyalty</span>
  ) : (
    <span className="text-xs text-slate-400">—</span>
  );
}

export default function CustomersPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isDirectory = DIRECTORY_ROLES.includes(user?.roleCode ?? '');

  // Create form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // Shared search + directory state
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [letter, setLetter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'customerNumber' | 'lastVisit'>('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<{ hasLoyalty: boolean; hasVehicle: boolean; missingContact: boolean }>({
    hasLoyalty: false, hasVehicle: false, missingContact: false,
  });
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(searchTerm.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);
  // reset pagination whenever the query changes
  useEffect(() => { setOffset(0); }, [debouncedTerm, letter, sortBy, sortOrder, filters]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/customers', {
        firstName: newFirstName, lastName: newLastName, phone: newPhone,
        email: newEmail || undefined, notes: newNotes || undefined,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['customers-list'] });
      queryClient.invalidateQueries({ queryKey: ['customers-directory'] });
      router.push(`/customers/${data.id}`);
    },
  });
  const canCreate = newFirstName.trim() && newLastName.trim() && newPhone.trim();

  // --- Directory query (admin/manager) ---
  const directoryQs = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedTerm) p.set('q', debouncedTerm);
    if (letter) p.set('letter', letter);
    p.set('sortBy', sortBy);
    p.set('sortOrder', sortOrder);
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(offset));
    if (filters.hasLoyalty) p.set('hasLoyalty', 'true');
    if (filters.hasVehicle) p.set('hasVehicle', 'true');
    if (filters.missingContact) p.set('missingContact', 'true');
    return p.toString();
  }, [debouncedTerm, letter, sortBy, sortOrder, offset, filters]);

  const directoryQuery = useQuery({
    queryKey: ['customers-directory', directoryQs],
    queryFn: () => api.get<DirectoryResponse>(`/customers/directory?${directoryQs}`),
    enabled: isDirectory,
  });

  // --- Search query (non-admin search-first) ---
  const searchQuery = useQuery({
    queryKey: ['customers-list', debouncedTerm],
    queryFn: () => api.get<CustomerListItem[]>(`/customers?q=${encodeURIComponent(debouncedTerm)}`),
    enabled: !isDirectory && debouncedTerm.length >= 2,
  });

  const toggleFilter = (k: keyof typeof filters) => setFilters((f) => ({ ...f, [k]: !f[k] }));

  return (
    <div className="page-container">
      <PageHeader
        title="Customers"
        subtitle={isDirectory ? 'Customer directory — browse, search and manage records' : 'Search and manage customer records'}
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Customers' }]}
        actions={
          <button onClick={() => setShowCreateForm(!showCreateForm)} className={showCreateForm ? 'btn-secondary' : 'btn-primary'}>
            {showCreateForm ? 'Cancel' : '+ New Customer'}
          </button>
        }
      />

      {showCreateForm && (
        <div className="card mb-6">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">New Customer</h2></div>
          <div className="card-body space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="input-label">First Name *</label><input type="text" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} className="input-field" placeholder="e.g., John" /></div>
              <div><label className="input-label">Last Name *</label><input type="text" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} className="input-field" placeholder="e.g., Smith" /></div>
              <div><label className="input-label">Phone *</label><input type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} className="input-field" placeholder="e.g., 876-555-0123" /></div>
              <div><label className="input-label">Email</label><input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="input-field" placeholder="Optional" /></div>
            </div>
            <div><label className="input-label">Notes</label><input type="text" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} className="input-field" placeholder="Optional" /></div>
            {createMutation.isError && (
              <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create customer'}
              </div>
            )}
            <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
              <button onClick={() => createMutation.mutate()} disabled={!canCreate || createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? 'Creating...' : 'Create Customer'}
              </button>
              <button onClick={() => setShowCreateForm(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Search bar (both modes) */}
      <div className="mb-4">
        <div className="relative max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={isDirectory ? 'Search name, customer #, email…' : 'Search by name, phone, or customer number…'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input-field pl-10"
          />
        </div>
      </div>

      {isDirectory ? (
        <DirectoryView
          query={directoryQuery}
          letter={letter}
          setLetter={setLetter}
          sortBy={sortBy} setSortBy={setSortBy}
          sortOrder={sortOrder} setSortOrder={setSortOrder}
          filters={filters} toggleFilter={toggleFilter}
          offset={offset} setOffset={setOffset}
        />
      ) : (
        <SearchView query={searchQuery} hasTerm={debouncedTerm.length >= 2} />
      )}
    </div>
  );
}

// --- Non-admin search-first view ---
function SearchView({ query, hasTerm }: { query: UseQueryResult<CustomerListItem[]>; hasTerm: boolean }) {
  if (!hasTerm) {
    return (
      <EmptyState
        title="Search for customers"
        description="Type at least 2 characters to search customers."
        icon={<svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>}
      />
    );
  }
  if (query.isLoading) return <LoadingState message="Searching..." />;
  if (query.isError) return <div className="card p-6 text-center border-red-200 bg-red-50"><p className="text-sm text-red-700">Failed to load customers.</p></div>;
  if (query.data && query.data.length === 0) return <EmptyState title="No customers found" description="Try a different search term." />;
  return <CustomerTable items={query.data ?? []} />;
}

// --- Admin/Manager directory view ---
function DirectoryView(props: {
  query: UseQueryResult<DirectoryResponse>;
  letter: string | null; setLetter: (l: string | null) => void;
  sortBy: 'name' | 'customerNumber' | 'lastVisit'; setSortBy: (s: 'name' | 'customerNumber' | 'lastVisit') => void;
  sortOrder: 'asc' | 'desc'; setSortOrder: (o: 'asc' | 'desc') => void;
  filters: { hasLoyalty: boolean; hasVehicle: boolean; missingContact: boolean }; toggleFilter: (k: 'hasLoyalty' | 'hasVehicle' | 'missingContact') => void;
  offset: number; setOffset: (n: number) => void;
}) {
  const { query, letter, setLetter, sortBy, setSortBy, sortOrder, setSortOrder, filters, toggleFilter, offset, setOffset } = props;
  const data = query.data;
  const total = data?.total ?? 0;

  const chip = (active: boolean) => `px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`;

  return (
    <>
      {/* A–Z rail */}
      <div className="flex flex-wrap gap-1 mb-3">
        <button onClick={() => setLetter(null)} className={chip(letter === null)}>All</button>
        {LETTERS.map((l) => (
          <button key={l} onClick={() => setLetter(l)} className={chip(letter === l)}>{l}</button>
        ))}
      </div>

      {/* Filters + sort */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={() => toggleFilter('hasLoyalty')} className={chip(filters.hasLoyalty)}>★ Loyalty</button>
        <button onClick={() => toggleFilter('hasVehicle')} className={chip(filters.hasVehicle)}>Has vehicle</button>
        <button onClick={() => toggleFilter('missingContact')} className={chip(filters.missingContact)}>Missing contact</button>
        <div className="ml-auto flex items-center gap-2">
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'name' | 'customerNumber' | 'lastVisit')} className="input-field py-1.5 text-xs w-auto">
            <option value="name">Sort: Name</option>
            <option value="customerNumber">Sort: Customer #</option>
            <option value="lastVisit">Sort: Last visit</option>
          </select>
          <button onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')} className="btn-secondary text-xs py-1.5" title="Toggle sort direction">
            {sortOrder === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>
        </div>
      </div>

      {query.isLoading && <LoadingState message="Loading directory..." />}
      {query.isError && <div className="card p-6 text-center border-red-200 bg-red-50"><p className="text-sm text-red-700">Failed to load directory.</p></div>}
      {data && data.items.length === 0 && <EmptyState title="No customers match" description="Adjust the letter, filters or search." />}

      {data && data.items.length > 0 && (
        <>
          <CustomerTable items={data.items} />
          <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="btn-secondary text-xs disabled:opacity-40">Previous</button>
              <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total} className="btn-secondary text-xs disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// --- Shared table (no phone column) ---
function CustomerTable({ items }: { items: CustomerListItem[] }) {
  return (
    <div className="table-container">
      <table className="w-full text-sm">
        <thead className="table-header">
          <tr>
            <th>Name</th>
            <th>Customer #</th>
            <th>Loyalty</th>
            <th>Vehicles</th>
            <th>Last visit</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} className="table-row cursor-pointer">
              <td>
                <Link href={`/customers/${c.id}`} className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline">
                  {c.firstName} {c.lastName}
                </Link>
                {c.missingContact && <span className="ml-2 badge bg-amber-50 text-amber-700">No contact</span>}
              </td>
              <td className="font-mono text-xs text-slate-500">{c.customerNumber}</td>
              <td><LoyaltyBadge on={c.hasLoyalty} /></td>
              <td className="text-slate-700">{c.vehicleCount}</td>
              <td className="text-slate-500 text-xs">{relTime(c.lastVisitAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
