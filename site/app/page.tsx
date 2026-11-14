import Link from "next/link";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import { RecordChart } from "@/components/RecordChart";
import { HoldoutStats } from "@/components/HoldoutStats";
import { loadAnnual, REGIONS } from "@/lib/data";

export default function RecordPage() {
  const data = loadAnnual("portugal");
  const i2012 = data.years.indexOf(2012);
  const modisMean = data.modis.slice(0, i2012).reduce((p, c) => p + c, 0) / i2012;
  const viirs = data.viirs.filter((v): v is number => v != null);
  const jump = viirs.reduce((p, c) => p + c, 0) / viirs.length / modisMean;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-4 pt-12 pb-20 sm:px-6 md:pt-16">
      <section className="grid items-end gap-8 md:grid-cols-12">
        <div className="flex flex-col gap-4 md:col-span-8">
          <p className="text-xs font-medium tracking-[0.16em] text-primary uppercase">
            {REGIONS.portugal}, 2001-2025
          </p>
          <h1 className="max-w-[18ch] text-4xl leading-[1.05] font-semibold tracking-tighter text-balance md:text-5xl lg:text-6xl">
            Two satellites, one fire record.
          </h1>
          <p className="max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
            MODIS and VIIRS count fire differently. We convert the MODIS years into VIIRS terms so 25 years compare
            fairly.
          </p>
        </div>
        <div className="flex flex-col gap-1 border-l-2 border-primary pl-5 md:col-span-4 md:justify-self-end">
          <span className="font-mono text-5xl font-semibold tracking-tight tabular-nums">×{jump.toFixed(1)}</span>
          <span className="max-w-[28ch] text-sm leading-relaxed text-muted-foreground">
            apparent rise in yearly detections when VIIRS replaces MODIS in 2012
          </span>
        </div>
      </section>

      <section aria-labelledby="record-heading" className="rounded-xl border bg-card p-4 sm:p-6">
        <h2 id="record-heading" className="sr-only">
          Annual active-fire detections
        </h2>
        <RecordChart data={data} />
      </section>

      <section aria-labelledby="holdout-heading" className="flex flex-col gap-6">
        <div className="flex max-w-[65ch] flex-col gap-2">
          <h2 id="holdout-heading" className="text-2xl font-semibold tracking-tight">
            Tested on years it never saw
          </h2>
          <p className="leading-relaxed text-muted-foreground">
            The model learned from 2012-2019, when both sensors flew. We then predicted 2020-2025 from MODIS alone and
            checked against what VIIRS saw.
          </p>
        </div>
        <HoldoutStats score={data.score} />
      </section>

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
