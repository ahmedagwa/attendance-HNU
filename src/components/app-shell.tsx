import Link from "next/link";
import { SignOutButton } from "./sign-out-button";

export type NavItem = { href: string; label: string };

export function AppShell({ title, name, nav, children, wide = false }: { title: string; name: string; nav: NavItem[]; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-paper pt-[env(safe-area-inset-top)]">
        <div className={`mx-auto flex items-center justify-between gap-3 px-4 py-3 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
          <div className="min-w-0">
            <p className="font-display text-lg font-bold leading-tight">{title}</p>
            <p className="truncate text-sm text-ink-soft">{name}</p>
          </div>
          <SignOutButton />
        </div>
        <nav aria-label="Sections" className={`mx-auto flex gap-1 overflow-x-auto px-3 pb-2 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>
          {nav.map((n) => <Link key={n.href} href={n.href} className="btn btn-quiet min-h-10 whitespace-nowrap border-transparent text-sm">{n.label}</Link>)}
        </nav>
      </header>
      <main className={`mx-auto px-4 py-6 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</main>
    </div>
  );
}

export const statusPill: Record<string, string> = { present: "pill pill-ok", late: "pill pill-warn", review: "pill pill-warn", rejected: "pill pill-bad", absent: "pill pill-mute" };
