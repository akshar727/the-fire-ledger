import Link from "next/link";
import { Suspense } from "react";
import { FlameIcon } from "@phosphor-icons/react/dist/ssr";
import { NavLinks, SiteNav } from "@/components/SiteNav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background">
      <div className="flex h-9 items-stretch justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 border-r px-3 font-mono text-[10px] font-semibold tracking-[0.06em] whitespace-nowrap uppercase sm:gap-2.5 sm:px-4 sm:text-[11px] sm:tracking-[0.14em]"
        >
          <FlameIcon weight="fill" className="size-4 text-primary drop-shadow-[0_0_6px_var(--primary)]" aria-hidden />
          One Fire Record
        </Link>
        <Suspense fallback={<NavLinks />}>
          <SiteNav />
        </Suspense>
      </div>
    </header>
  );
}
