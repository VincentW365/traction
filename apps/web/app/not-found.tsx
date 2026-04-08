import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-8">
          <img src="/brand-mark.png" alt="Bert's Auto Parts" className="h-10 w-auto object-contain" />
        </div>
        <div className="text-8xl font-bold text-slate-200 mb-2 tracking-tight">404</div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">Page Not Found</h1>
        <p className="text-sm text-slate-500 mb-8">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link href="/" className="btn-primary px-8 py-2.5">
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
