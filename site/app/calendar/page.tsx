import type { Metadata } from "next";
import { BurnCalendar } from "@/components/BurnCalendar";
import { REGIONS } from "@/lib/data";

export const metadata: Metadata = { title: "Burn calendar" };

export default function CalendarPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 pt-12 pb-20 sm:px-6 md:pt-16">
      <header className="flex max-w-[65ch] flex-col gap-4">
        <h1 className="text-4xl leading-[1.05] font-semibold tracking-tighter md:text-5xl">Burn calendar</h1>
        <p className="text-lg leading-relaxed text-muted-foreground">
          Which months burn in {REGIONS.portugal}, and which years broke the pattern. Every month is on the VIIRS scale.
        </p>
      </header>
      <BurnCalendar region="portugal" />
    </main>
  );
}
