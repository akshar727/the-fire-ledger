"use client";

// FE-020: the proof up front. Hold-out error, band coverage and the burned-area check for the selected region, right under
// the hero number on /record. Numbers come from annual.json `score` and referee.json; wording from lib/proof.ts.
import Link from "next/link";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { estimateOf, holdoutYears, isSparse } from "@/lib/annual";
import { loadReferee, type Annual } from "@/lib/data";
import { proof } from "@/lib/proof";
import { useSelection } from "@/lib/use-selection";

const REF = loadReferee();

function Item({ value, text, href, accent }: { value: string; text: string; href: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 py-4 md:px-6 md:first:pl-0 md:last:pr-0">
      <span className={`font-mono text-2xl font-semibold tracking-tight tabular-nums ${accent ? "text-primary" : ""}`}>{value}</span>
      <span className="text-sm leading-relaxed text-muted-foreground">
        {text}{" "}
        <Link href={href} className="inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline">
          How<span className="sr-only"> we checked this</span>
          <ArrowRightIcon className="size-3" aria-hidden />
        </Link>
      </span>
    </div>
  );
}

export function ValidationStrip({ data: D }: { data: Annual }) {
  const { sel } = useSelection();
  // FE-029: a whole country's line may be a constant-ratio estimate (or too sparse to check); the wording says which
  const p = proof(D.score, holdoutYears(D), REF.regions[sel.region], REF, {
    kind: estimateOf(D),
    sparse: isSparse(D),
    modelScore: D.model_score,
  });
  return (
    <section aria-labelledby="proof-heading" className="flex flex-col gap-1 border-y">
      <h2 id="proof-heading" className="pt-4 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
        Checked, not assumed
      </h2>
      <div className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
        <Item value={p.error} text={p.errorText} href="/method#holdout" accent={!p.ratioWins} />
        <Item value={p.band} text={p.bandText} href="/method#holdout" />
        {p.jump && p.jumpText && <Item value={p.jump} text={p.jumpText} href="/method#referee" />}
      </div>
    </section>
  );
}
