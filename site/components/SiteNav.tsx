"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/ledger", label: "Ledger" },
  { href: "/calendar", label: "Calendar" },
  { href: "/method", label: "Method" },
] as const;

/**
 * Nav links. Every link carries the current ?region=&from=&to=, Method included (it ignores them), so a visit to
 * Method and back keeps the selection.
 */
export function NavLinks({ query = "" }: { query?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-stretch">
      {LINKS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={query ? `${href}?${query}` : href}
            aria-current={active ? "page" : undefined}
            className={cn(
              // status-strip tab: mono caps, hairline divider, red underline when current
              "relative flex items-center border-l px-2 font-mono text-[10px] tracking-[0.06em] uppercase sm:text-[11px] sm:tracking-[0.14em] transition-colors hover:bg-primary/8 hover:text-foreground sm:px-[18px]",
              active
                ? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary"
                : "text-muted-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Reads the selection from the URL; render inside Suspense with `<NavLinks />` as the fallback. */
export function SiteNav() {
  const params = useSearchParams();
  const keep = new URLSearchParams();
  for (const k of ["region", "from", "to"]) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  return <NavLinks query={keep.toString()} />;
}
