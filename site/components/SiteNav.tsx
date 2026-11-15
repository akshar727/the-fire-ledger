"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Record", keepsSelection: true },
  { href: "/calendar", label: "Calendar", keepsSelection: true },
  { href: "/method", label: "Method", keepsSelection: false },
] as const;

/** Nav links; the data views carry the current ?region=&from=&to= so switching view keeps the selection. */
export function NavLinks({ query = "" }: { query?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {LINKS.map(({ href, label, keepsSelection }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={keepsSelection && query ? `${href}?${query}` : href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground",
              active ? "font-medium text-foreground" : "text-muted-foreground",
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
