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
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 pt-6 pb-20 sm:px-6">
      {/* FE-025: compact header so the controls and the chart fit on a laptop's first screen */}
      <section className="grid items-end gap-5 md:grid-cols-12">
        <div className="flex flex-col gap-2 md:col-span-8">
          <h1 className="text-3xl leading-tight font-bold tracking-tight text-balance md:text-4xl">
            Two satellites, one fire record.
          </h1>
          <p className="max-w-[62ch] leading-relaxed text-muted-foreground">
            MODIS and VIIRS count fire differently, so we put the MODIS years into VIIRS terms and every year from {first}{" "}
            to {lastComplete} compares fairly.
          </p>
        </div>
        {/* region-specific parts read ?region=&from=&to=; Suspense keeps the page statically rendered */}
        <Suspense fallback={<div className="h-20 md:col-span-4" />}>
          <JumpStat />
        </Suspense>
      </section>

      {/* the proof strip (FE-020) sits right under the chart, inside RecordExplorer (FE-025) */}
      <Suspense fallback={<RecordSkeleton />}>
        <RecordExplorer />
      </Suspense>

      <section className="panel flex flex-col items-start justify-between gap-4 px-6 py-8 sm:flex-row sm:items-center">
        <p className="max-w-[55ch] text-lg leading-relaxed">
          How the conversion works, what the hold-out proves, and where it is still weak.
        </p>
        <Link
          href="/method"
          className="btn-console"
        >
          Read the method
          <ArrowRightIcon className="size-4" aria-hidden />
        </Link>
      </section>
    </main>
  );
}
