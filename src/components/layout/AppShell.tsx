import Link from 'next/link';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-edgelord-bg text-edgelord-text-primary min-h-screen">
      <header className="p-4 border-b border-edgelord-border">
        <nav className="container mx-auto flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-edgelord-primary">
            EdgeLord
          </Link>
          <div className="flex gap-4">
            <Link href="/markets" className="hover:text-edgelord-primarySoft">
              Markets
            </Link>
            <Link href="/signals" className="hover:text-edgelord-primarySoft">
              Signals
            </Link>
          </div>
        </nav>
      </header>
      <main className="container mx-auto p-4">
        {children}
      </main>
    </div>
  );
}