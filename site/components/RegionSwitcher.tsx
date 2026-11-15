"use client";

// FE-008: region picker for every data view, a search box over ~180 places (WAI-ARIA combobox with a listbox popup).
// Typing filters; the list has "Deep dives" (the cell regions) and "Countries" (A to Z, with the ship label as a tag);
// an empty group is not shown. Arrow keys / Page Up / Page Down move, Enter picks, Escape closes. The choice is written
// to ?region= as before (useSelection), so links are unchanged.
import { useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { groupRegions, PICKER_ITEMS } from "@/lib/region-picker";
import { isRegionId, REGIONS } from "@/lib/regions";
import { useSelection } from "@/lib/use-selection";

const field =
  "h-9 w-full rounded-md border border-input bg-background pr-9 pl-8 text-base shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 md:text-sm"; // 16px on phones so iOS does not zoom in on focus

export function RegionSwitcher({ className = "" }: { className?: string }) {
  const { sel, update } = useSelection();
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const groups = groupRegions([...PICKER_ITEMS], open ? query : "");
  const options = groups.flatMap((g) => g.items);
  const starts = groups.map((_, k) => groups.slice(0, k).reduce((n, g) => n + g.items.length, 0));

  const show = () => {
    if (open) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((it) => it.id === sel.region)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (region: string) => {
    close();
    if (isRegionId(region) && region !== sel.region) update({ region });
  };
  const move = (by: number) => setActive((a) => Math.min(Math.max(a + by, 0), Math.max(options.length - 1, 0)));

  // keep the highlighted option in view while moving with the keyboard (the list scrolls, never the page)
  useEffect(() => {
    const list = listRef.current;
    const opt = open ? document.getElementById(optId(active)) : null;
    if (!list || !opt) return;
    if (opt.offsetTop < list.scrollTop) list.scrollTop = opt.offsetTop;
    else if (opt.offsetTop + opt.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = opt.offsetTop + opt.offsetHeight - list.clientHeight;
  }, [open, active, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const step = ({ ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 } as Record<string, number>)[e.key];
    if (step !== undefined) {
      e.preventDefault();
      if (open) move(step);
      else show();
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      if (options[active]) choose(options[active].id);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      className={`relative flex flex-col gap-1.5 ${className}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        Region or country
      </label>
      <div className="relative">
        <MagnifyingGlassIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? optId(active) : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // closed: the field shows the current place; open: what is typed, with the current place as the hint
          value={open ? query : REGIONS[sel.region]}
          placeholder={REGIONS[sel.region]}
          onClick={show}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            // typed while the list was closed (tabbed in, or after Escape): the field held the current place's name,
            // so search only for what was typed after it
            const v = e.target.value;
            const cur = REGIONS[sel.region];
            setQuery(!open && v.startsWith(cur) ? v.slice(cur.length) : v);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={field}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Close the list" : "Show every region and country"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) close();
            else show();
            inputRef.current?.focus();
          }}
          className="absolute top-0 right-0 grid h-9 w-9 place-items-center text-muted-foreground hover:text-foreground"
        >
          <CaretDownIcon aria-hidden className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Regions and countries"
          // a press anywhere in the list (heading, scrollbar, "no match") keeps focus in the field, so the list stays open
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[min(20rem,60vh)] overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {groups.map((g, k) => (
            <div key={g.label} role="group" aria-labelledby={`${id}-g${k}`}>
              <div
                id={`${id}-g${k}`}
                className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {g.label}
              </div>
              {g.items.map((it, j) => {
                const i = starts[k] + j;
                const selected = it.id === sel.region;
                return (
                  <div
                    key={it.id}
                    id={optId(i)}
                    role="option"
                    aria-selected={selected}
                    data-active={i === active}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => choose(it.id)}
                    className="flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[active=true]:bg-primary/15"
                  >
                    <CheckIcon aria-hidden className={`size-3.5 shrink-0 text-primary ${selected ? "" : "invisible"}`} />
                    {/* the tag sits under the name: the Record page's column is narrow */}
                    <span className="min-w-0 flex-1 leading-snug">
                      {it.name}
                      {it.tag && (
                        <span className="mt-0.5 block w-fit rounded-sm border px-1.5 py-px text-[11px] leading-tight text-muted-foreground">
                          {it.tag}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {options.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">No region or country matches “{query.trim()}”.</p>
          )}
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {open && query ? `${options.length} ${options.length === 1 ? "match" : "matches"}` : ""}
      </span>
    </div>
  );
}
