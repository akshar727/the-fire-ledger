"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/globe", label: "Globe" },
  { href: "/ledger", label: "Ledger" },
  { href: "/calendar", label: "Calendar" },
  { href: "/method", label: "Method" },
  { href: "/method#scoreboard", label: "Scoreboard", wide: true },
] as const;

const withQuery = (href: string, query: string) => {
  if (!query) return href;
  const [path, hash] = href.split("#");
  return `${path}?${query}${hash ? `#${hash}` : ""}`;
};

export function NavLinks({ query = "" }: { query?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-stretch">
      {LINKS.map((link) => {
        const { href, label } = link;
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={withQuery(href, query)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center border-l px-1.5 font-mono text-[10px] tracking-[0.06em] uppercase sm:text-[11px] sm:tracking-[0.14em] transition-colors hover:bg-primary/8 hover:text-foreground sm:px-[18px]",
              active
                ? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary"
                : "text-muted-foreground",
              "wide" in link && link.wide && "max-md:hidden",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SiteNav() {
  const params = useSearchParams();
  const keep = new URLSearchParams();
  for (const k of ["region", "from", "to"]) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  return <NavLinks query={keep.toString()} />;
}
