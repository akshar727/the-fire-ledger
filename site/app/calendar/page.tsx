import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarSkeleton } from "@/components/BurnCalendar";
import { CalendarExplorer } from "@/components/CalendarExplorer";

export const metadata: Metadata = { title: "Burn calendar" };

export default function CalendarPage() {
  return (
    // FE-025: compact header (as on the Ledger page) so the card, the controls and the calendar fit on a laptop's first screen
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-6 pb-20 sm:px-6">
      <header className="flex max-w-[65ch] flex-col gap-1.5">
        <h1 className="text-3xl leading-tight font-bold tracking-tight md:text-4xl">Burn calendar</h1>
        <p className="leading-relaxed text-muted-foreground">
          Which months burn and which years broke the pattern, every month on the VIIRS scale.
        </p>
      </header>
      {/* useSearchParams needs a Suspense boundary to keep the page statically rendered */}
      <Suspense fallback={<CalendarSkeleton />}>
        <CalendarExplorer />
      </Suspense>
    </main>
  );
}
