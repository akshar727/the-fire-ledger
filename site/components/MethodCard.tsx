"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { fetchAnnual } from "@/lib/data";
import { methodCard } from "@/lib/method-card";
import { useSelection } from "@/lib/use-selection";

export function MethodCard() {
  const { sel } = useSelection();
  const data = use(fetchAnnual(sel.region));
  const card = data && methodCard(data);
  if (!card) return null;
  const model = card.ship === "model" || card.ship === "caveat";
  return (
    <section
      aria-labelledby="method-card-heading"
      className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-4 sm:flex-row sm:items-center sm:gap-6 sm:px-6"
    >
      <div className="flex shrink-0 flex-col gap-1.5">
        <h2 id="method-card-heading" className="kicker">
          How this record was made
        </h2>
        <span
          className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-sm font-semibold ${
            model ? "border-primary text-primary" : "text-foreground"
          }`}
        >
          {card.badge}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="max-w-[75ch] text-sm leading-relaxed">
          {card.why}
          {card.band && <span className="text-muted-foreground"> {card.band}</span>}
        </p>
        <Link
          href="/method#scoreboard"
          className="inline-flex w-fit items-center gap-1 text-sm text-foreground underline underline-offset-4 hover:text-primary"
        >
          See every country&apos;s result
          <ArrowRightIcon className="size-3.5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
