import Link from "next/link";
import { FlameIcon } from "@phosphor-icons/react/dist/ssr";
import { SiteNav } from "@/components/SiteNav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <FlameIcon weight="fill" className="size-5 text-primary" aria-hidden />
          One Fire Record
        </Link>
        <SiteNav />
      </div>
    </header>
  );
}
