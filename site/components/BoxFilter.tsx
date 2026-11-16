"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { boxError, boxesOverlap, boxLabel, type Box } from "@/lib/selection";

const field =
  "h-9 w-full rounded-md border border-input bg-background px-2.5 font-mono text-sm tabular-nums shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30";

type Edge = "s" | "n" | "w" | "e";
type Draft = Record<Edge, string>;

const EDGES: { key: Edge; label: string }[] = [
  { key: "s", label: "South edge (latitude)" },
  { key: "n", label: "North edge (latitude)" },
  { key: "w", label: "West edge (longitude)" },
  { key: "e", label: "East edge (longitude)" },
];

const keyOf = (b: Box | null) => (b ? [b.w, b.s, b.e, b.n].join(",") : "");
const toDraft = (b: Box | null): Draft =>
  b ? { s: String(b.s), n: String(b.n), w: String(b.w), e: String(b.e) } : { s: "", n: "", w: "", e: "" };
const num = (v: string) => (v.trim() === "" ? NaN : Number(v.trim()));

export function BoxFilter({
  box,
  region,
  regionName,
  onApply,
}: {
  box: Box | null;
  region: Box;
  regionName: string;
  onApply: (box: Box | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(toDraft(box));
  const [shown, setShown] = useState(keyOf(box));
  const [error, setError] = useState<string | null>(null);
  if (keyOf(box) !== shown) {
    setShown(keyOf(box));
    setDraft(toDraft(box));
    setError(null);
  }

  const apply = () => {
    const b = { w: num(draft.w), s: num(draft.s), e: num(draft.e), n: num(draft.n) };
    const why =
      boxError(b) ??
      (boxesOverlap(b, region) ? null : `That box is outside ${regionName} (${boxLabel(region)}), so no detection would match.`);
    setError(why);
    if (!why) onApply(b);
  };

  return (
    <form
      className="flex flex-col gap-3"
      aria-labelledby={`${id}-legend`}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="flex flex-col gap-1">
        <p id={`${id}-legend`} className="text-sm font-medium">
          Limit the CSV to a box <span className="font-normal text-muted-foreground">(optional)</span>
        </p>
        <p id={`${id}-help`} className="max-w-[60ch] text-xs leading-relaxed text-muted-foreground">
          Decimal degrees; south latitudes and west longitudes are negative. Edges are included. Empty fields show{" "}
          {regionName}&apos;s own box.
        </p>
      </div>
      <div className="grid max-w-md grid-cols-2 gap-3">
        {EDGES.map(({ key, label }) => (
          <div key={key} className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-${key}`} className="text-xs font-medium text-muted-foreground">
              {label}
            </label>
            <input
              id={`${id}-${key}`}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              className={field}
              placeholder={String(region[key])}
              value={draft[key]}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <p id={`${id}-error`} aria-live="polite" className="max-w-[60ch] text-sm text-destructive empty:hidden">
        {error}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" size="sm">
          Apply box
        </Button>
        {box ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onApply(null)}>
            Clear box (whole region)
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(toDraft(region));
              setError(null);
            }}
          >
            Start from the region&apos;s box
          </Button>
        )}
      </div>
    </form>
  );
}
