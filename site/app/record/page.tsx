import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import { JumpStat, RecordExplorer, RecordSkeleton } from "@/components/RecordExplorer";
import { recordSpan } from "@/lib/data";

export const metadata: Metadata = { title: "Record" };

export default function RecordPage() {
  const { first, lastComplete } = recordSpan();
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-4 pt-12 pb-20 sm:px-6 md:pt-16">
      <section className="grid items-end gap-8 md:grid-cols-12">
        <div className="flex flex-col gap-4 md:col-span-8">
          <h1 className="max-w-[18ch] text-4xl leading-[1.05] font-semibold tracking-tighter text-balance md:text-5xl lg:text-6xl">
            Two satellites, one fire record.
          </h1>
          <p className="max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
            MODIS and VIIRS count fire differently. We convert the MODIS years into VIIRS terms so every year from{" "}
            {first} to {lastComplete} compares fairly.
          </p>
        </div>
        {/* region-specific parts read ?region=&from=&to=; Suspense keeps the page statically rendered */}
        <Suspense fallback={<div className="h-28 md:col-span-4" />}>
          <JumpStat />
        </Suspense>
      </section>

      <Suspense fallback={<RecordSkeleton />}>
        <RecordExplorer />
      </Suspense>

      <section className="flex flex-col items-start justify-between gap-4 rounded-xl bg-accent px-6 py-8 sm:flex-row sm:items-center">
        <p className="max-w-[55ch] text-lg leading-relaxed">
          How the conversion works, what the hold-out proves, and where it is still weak.
        </p>
        <Link
          href="/method"
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium whitespace-nowrap text-primary-foreground transition-transform hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.98]"
        >
          Read the method
          <ArrowRightIcon className="size-4" aria-hidden />
        </Link>
      </section>
    </main>
  );
}
