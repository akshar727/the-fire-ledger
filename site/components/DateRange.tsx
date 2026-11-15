"use client";

// From / to date filter (UTC days, both included) plus a whole-year shortcut. A date is written to the URL only once it
// is a complete date inside the record, so typing a year digit by digit doesn't jump the field to the first year.
import { useId, useState } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { isDate, yearRange, yearsIn, type Bounds } from "@/lib/selection";
import { useSelection } from "@/lib/use-selection";

const field =
  "h-9 rounded-md border border-input bg-background px-2.5 font-mono text-sm tabular-nums shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 [color-scheme:light] dark:[color-scheme:dark]";

function DateField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  onCommit: (v: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    // the URL changed (region switch, reset, year shortcut): show the new value
    setShown(value);
    setDraft(value);
  }
  const ok = (v: string) => isDate(v) && v >= min && v <= max;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="date"
        className={field}
        value={draft}
        min={min}
        max={max}
        aria-invalid={!ok(draft) || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (ok(e.target.value)) onCommit(e.target.value);
        }}
        onBlur={() => !ok(draft) && setDraft(value)}
      />
    </div>
  );
}

export function DateRange() {
  const { sel, bounds, update } = useSelection();
  const yearId = useId();
  const years = yearsIn(bounds.min, bounds.max);
  const single = years.find((y) => {
    const r = yearRange(y, bounds);
    return r.from === sel.from && r.to === sel.to;
  });
  return (
    <div className="flex flex-wrap items-end gap-3">
      <DateField label="From" value={sel.from} min={bounds.min} max={sel.to} onCommit={(from) => update({ from })} />
      <DateField label="To" value={sel.to} min={sel.from} max={bounds.max} onCommit={(to) => update({ to })} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={yearId} className="text-xs font-medium text-muted-foreground">
          Or one year
        </label>
        <select
          id={yearId}
          className={field}
          value={single ?? ""}
          onChange={(e) => e.target.value && update(yearRange(Number(e.target.value), bounds))}
        >
          <option value="" disabled>
            Year
          </option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {!sel.whole && <ResetButton bounds={bounds} onReset={update} />}
    </div>
  );
}

function ResetButton({ bounds, onReset }: { bounds: Bounds; onReset: (r: { from: string; to: string }) => void }) {
  return (
    <Button variant="ghost" size="lg" onClick={() => onReset({ from: bounds.min, to: bounds.max })}>
      <ArrowCounterClockwiseIcon aria-hidden />
      Whole record
    </Button>
  );
}
