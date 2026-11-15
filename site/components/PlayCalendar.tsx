"use client";

// FE-013: "Hear the 2012 satellite jump". One button plays the years around the 2012 sensor switch twice with Web
// Audio (no library): raw record first (notes jump up at 2012), then harmonized (no jump). lib/sonify.ts builds the
// notes; this component schedules them a little ahead (a few dozen live nodes, not one per cell) and marks the sounding
// cell with a `data-playing` attribute on the calendar's table, so the calendar does not re-render on every note.
// No AudioContext exists until the click. Unmounting, Next hiding the page on navigation, or a Month / Week switch
// closes it; region and date changes remount the calendar.
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { SpeakerHighIcon, StopIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { periodLabel, type CalendarGrid } from "@/lib/series";
import { jumpTour, noteAt, tourSummary, type Note } from "@/lib/sonify";

const LOOKAHEAD = 2; // seconds of notes scheduled ahead; > 1 s because background tabs run timers once a second
const TAIL = 0.3; // seconds to let the last note ring before closing
const CLIP = ["Clip 1 of 2, raw record", "Clip 2 of 2, harmonized record"];
const GAP_LINE = "Pause. Next: clip 2 of 2, harmonized record";

const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

type Props = {
  grid: CalendarGrid;
  raw: (number | null)[];
  table: RefObject<HTMLTableElement | null>; // cells carry data-cell="row-col"; the sounding one gets data-playing
  onAnnounce: (text: string) => void;
};

type Run = { ac: AudioContext; timer: number; frame: number };

export function PlayCalendar({ grid, raw, table, onAnnounce }: Props) {
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState<string | null>(null);
  const run = useRef<Run | null>(null);
  const tour = useMemo(() => jumpTour(grid, raw), [grid, raw]);
  const captionId = useId();

  const mark = (n: Note | null) => {
    const t = table.current;
    if (!t) return;
    t.querySelector("[data-playing]")?.removeAttribute("data-playing");
    if (!n) return;
    const el = t.querySelector<HTMLElement>(`[data-cell="${n.row}-${n.col}"]`);
    if (!el) return;
    el.setAttribute("data-playing", "");
    // follow the sound only while the calendar is on screen, so scrolling away mid-playback is not undone
    const box = t.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: smooth ? "smooth" : "auto" });
    }
  };

  // closes the audio and clears the highlight; touches no React state, so it is safe in cleanups
  const silence = () => {
    const r = run.current;
    run.current = null;
    if (r) {
      clearInterval(r.timer);
      cancelAnimationFrame(r.frame);
      r.ac.close().catch(() => {});
    }
    mark(null);
  };

  const stop = (said = "Stopped.") => {
    silence();
    setPlaying(false);
    setNow(null);
    onAnnounce(said);
  };

  // unmount, Next hiding the page, or a Month / Week switch: stop and reset
  const silenceRef = useRef(silence);
  useEffect(() => {
    silenceRef.current = silence;
  });
  useEffect(
    () => () => {
      silenceRef.current();
      setPlaying(false);
      setNow(null);
    },
    [grid.view],
  );

  const play = () => {
    silence();
    if (!tour) return;
    const { notes, seconds } = tour;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      onAnnounce("This browser cannot play sound.");
      return;
    }
    const ac = new AC();
    // master chain: tone filter -> volume -> limiter -> speakers
    const tone = ac.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    const volume = ac.createGain();
    volume.gain.value = 0.25;
    tone.connect(volume).connect(ac.createDynamicsCompressor()).connect(ac.destination);
    const t0 = ac.currentTime + 0.1;

    const voice = (n: Note) => {
      if (n.freq == null) return; // silent step
      const start = t0 + n.at;
      const osc = ac.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = n.freq;
      const env = ac.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + Math.min(0.01, n.dur / 4));
      env.gain.exponentialRampToValueAtTime(0.001, start + n.dur);
      osc.connect(env).connect(tone);
      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    };

    let next = 0; // first note not yet scheduled
    const pump = () => {
      if (run.current?.ac !== ac) return;
      const elapsed = ac.currentTime - t0;
      while (next < notes.length && notes[next].at < elapsed + LOOKAHEAD) voice(notes[next++]);
      if (elapsed > seconds + TAIL) stop("Finished.");
    };

    // the note heard now: audio clock minus the output delay (large on Bluetooth)
    let shown: Note | null | undefined;
    const tick = () => {
      const r = run.current;
      if (r?.ac !== ac) return;
      const time = ac.currentTime - (ac.outputLatency || ac.baseLatency || 0) - t0;
      const { note: n } = noteAt(tour, time);
      if (n !== shown) {
        shown = n;
        mark(n);
        if (n) setNow(`${CLIP[n.part]}: ${periodLabel(n.cell)}, ${n.value == null ? "no data" : `${fmt(n.value)} detections`}`);
        else if (time > 0 && time < tour.partStart) setNow(GAP_LINE);
      }
      r.frame = requestAnimationFrame(tick);
    };

    run.current = { ac, timer: window.setInterval(pump, 100), frame: requestAnimationFrame(tick) };
    pump();
    setPlaying(true);
    onAnnounce(tourSummary(tour.years, tour.switchYear));
    ac.resume().then(
      () => {
        if (run.current?.ac === ac && ac.state !== "running") stop("The browser blocked the sound. Click the button again.");
      },
      () => run.current?.ac === ac && stop("The browser blocked the sound. Click the button again."),
    );
  };

  const year = tour?.switchYear ?? grid.firstObserved?.year ?? 2012;

  return (
    // FE-025: button and its one-sentence caption on one line where they fit, no box, so the calendar starts higher.
    // The now-playing line has its own row of fixed height (one line, cut short if too long), so the text changing on
    // every note never moves the caption or the calendar below it.
    <div className="flex flex-col gap-y-1.5">
      <div className="flex flex-col gap-x-4 gap-y-1.5 sm:flex-row sm:items-center">
        <Button
          size="sm"
          onClick={() => (playing ? stop() : play())}
          disabled={!tour}
          aria-describedby={captionId}
          className="shrink-0 self-start active:scale-[0.98] sm:self-auto"
        >
          {playing ? <StopIcon weight="fill" aria-hidden /> : <SpeakerHighIcon weight="fill" aria-hidden />}
          {playing ? "Stop playing" : `Hear the ${year} satellite jump`}
        </Button>
        <p id={captionId} className="max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
          {tour ? (
            <>
              Plays {tour.years[0]} to {tour.years[1]} twice, <strong className="font-medium text-foreground">higher note = more fire</strong>:
              the raw record steps up in {year} when VIIRS takes over, the harmonized one barely does, because it was the
              satellite changing, not the fire.
            </>
          ) : (
            `Choose dates that include ${year} and at least one year before it to hear the satellite jump.`
          )}
        </p>
      </div>
      {tour && (
        <p className="h-5 truncate font-mono text-xs leading-5 text-muted-foreground tabular-nums" aria-hidden>
          {now}
        </p>
      )}
    </div>
  );
}
