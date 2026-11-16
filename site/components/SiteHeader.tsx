import Link from "next/link";
import { Suspense } from "react";
import { NavLinks, SiteNav } from "@/components/SiteNav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background">
      <div className="flex h-9 items-stretch justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 border-r px-3 font-mono text-[10px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase sm:gap-2.5 sm:px-4 sm:text-[11px] sm:tracking-[0.14em]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG logo (app/icon.svg) */}
          <img src="/icon.svg" alt="" width={20} height={20} className="size-5 shrink-0" aria-hidden />
          Fire Ledger
        </Link>
        <Suspense fallback={<NavLinks />}>
          <SiteNav />
        </Suspense>
      </div>
    </header>
  );
}
