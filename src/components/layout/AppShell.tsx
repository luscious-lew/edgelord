"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: "/sotu", label: "SOTU", emoji: "🎤" },
  { href: "/fomc", label: "FOMC", emoji: "🏛️" },
  { href: "/whpress", label: "WH Press", emoji: "🗣️" },
  { href: "/nba-trades", label: "NBA Trades", emoji: "🏀" },
  { href: "/superbowl-ads", label: "Super Bowl Ads", emoji: "📺" },
  { href: "/nfl-fa", label: "NFL FA", emoji: "🏈" },
  { href: "/markets", label: "Markets", emoji: "📊" },
  { href: "/signals", label: "Signals", emoji: "📡" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="bg-edgelord-bg text-edgelord-text-primary min-h-screen">
      <header className="p-4 border-b border-edgelord-border">
        <nav className="container mx-auto flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-edgelord-primary flex items-center gap-2">
            <span className="text-2xl">⚡</span>
            EdgeLord
          </Link>
          <div className="flex gap-6">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                  pathname === item.href
                    ? "bg-edgelord-primary/20 text-edgelord-primary"
                    : "hover:text-edgelord-primarySoft hover:bg-edgelord-surface"
                }`}
              >
                <span>{item.emoji}</span>
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      </header>
      <main className="container mx-auto p-4">
        {children}
      </main>
    </div>
  );
}