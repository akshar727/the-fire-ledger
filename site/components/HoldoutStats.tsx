import { InfoIcon } from "@phosphor-icons/react/dist/ssr";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Score } from "@/lib/data";

function Help({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <InfoIcon className="size-4" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}

/** Hold-out scores for the complete hold-out years (`years`, first and last), which the model never saw. FE-029: for a
 * whole country published as a constant-ratio estimate the first number is that estimate's error, labelled so; for a
 * country with too little fire the scores are noise, so a sentence replaces them. */
export function HoldoutStats({
  score,
  years,
  estimate = "model",
  sparse = false,
}: {
  score: Score;
  years: [number, number];
  estimate?: "model" | "ratio";
  sparse?: boolean;
}) {
  if (sparse)
    return (
      <p className="max-w-[65ch] border-y py-6 leading-relaxed text-muted-foreground">
        Too little fire here to score {years[0]}-{years[1]}: with so few detections a yearly error or a band count would be
        noise, so none is shown. Treat the years before 2012 as unchecked.
      </p>
    );
  const ours = estimate === "ratio" ? "this ratio estimate" : "our model";
  return (
    <dl className="grid grid-cols-1 divide-y border-y md:grid-cols-[1.5fr_1fr_1fr] md:divide-x md:divide-y-0">
      <div className="flex flex-col gap-3 py-6 md:pr-8">
        <dt className="flex items-center gap-1 text-sm text-muted-foreground">
          Mean annual error, hold-out years
          <Help label="About mean annual error">
            Average absolute gap between predicted and observed VIIRS totals per year, {years[0]}-{years[1]}.{" "}
            {estimate === "ratio" ? "This estimate is MODIS times this country's VIIRS/MODIS ratios (day and night apart). " : ""}
            The comparison is one {estimate === "ratio" ? "pooled" : "constant"} VIIRS/MODIS factor ({score.ratio.toFixed(2)}) fitted on the same training years.
          </Help>
        </dt>
        <dd className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-4xl font-semibold tracking-tight text-primary tabular-nums">
              {score.mape_model.toFixed(1)}%
            </span>
            <span className="text-sm text-muted-foreground">{ours}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-2xl tracking-tight text-muted-foreground tabular-nums">
              {score.mape_ratio.toFixed(1)}%
            </span>
            <span className="text-sm text-muted-foreground">{estimate === "ratio" ? "one pooled factor" : "constant factor"}</span>
          </span>
        </dd>
      </div>
      <div className="flex flex-col gap-3 py-6 md:px-8">
        <dt className="flex items-center gap-1 text-sm text-muted-foreground">
          Years inside the 5-95% band
          <Help label="About the band">
            How many hold-out years have an observed VIIRS total between the 5th and 95th percentile of the simulated
            totals. Fewer than expected means the band is still too narrow.
          </Help>
        </dt>
        <dd className="font-mono text-4xl font-semibold tracking-tight tabular-nums">
          {score.coverage}
          <span className="text-2xl text-muted-foreground"> of {score.n_hold}</span>
        </dd>
      </div>
      <div className="flex flex-col gap-3 py-6 md:pl-8">
        <dt className="flex items-center gap-1 text-sm text-muted-foreground">
          Weekly correlation
          <Help label="About weekly correlation">
            Pearson correlation between predicted and observed weekly VIIRS totals across the hold-out years.
          </Help>
        </dt>
        <dd className="font-mono text-4xl font-semibold tracking-tight tabular-nums">r = {score.weekly_r.toFixed(3)}</dd>
      </div>
    </dl>
  );
}
