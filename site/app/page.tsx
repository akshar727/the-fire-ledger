// Landing story (FE-018): six chapters that end in the data. Every number and figure comes from the published files
// (lib/story-data.ts, read while the page is prerendered), so `/` is static HTML that reads in full without
// JavaScript. StoryMotion only adds reveal and count-up effects. The tool itself lives at /record.
// FE-019: on wide screens with motion allowed, StorySceneGate puts a scroll-scrubbed canvas behind the chapters
// (pre-rendered frames in public/scene/). It is decoration: the chapters below stay the whole, accessible story.
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownIcon, ArrowRightIcon } from "@phosphor-icons/react/dist/ssr";
import { FireFootprints, SAT } from "@/components/story/FireFootprints";
import { StoryCalendar } from "@/components/story/StoryCalendar";
import { StoryLegend, StoryLine } from "@/components/story/StoryLine";
import { StoryMotion } from "@/components/story/StoryMotion";
import { StorySceneGate } from "@/components/story/StorySceneGate";
import { dayLabel, HOLD_FROM, VIIRS_FROM } from "@/lib/annual";
import { REGION_LIST } from "@/lib/data";
import { recordSpan } from "@/lib/data-server";
import { FIRE_SEASON } from "@/lib/regions";
import { rampColor } from "@/lib/series";
import { bigCount, jumpVerb, PIXEL_M, STORY_FIRE } from "@/lib/story";
import { loadStory } from "@/lib/story-data";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: { absolute: "One Fire Record" } };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
};
const monthYear = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

// Thermal console buttons (globals.css `btn-console`, `btn-quiet`)
const primaryLink = "btn-console";
const quietLink = "btn-quiet";

/** Fewer-to-more key under the story calendar: the same ramp, light and dark colours picked by CSS. */
function CalendarKey() {
  const steps = [0, 0.25, 0.5, 0.75, 1];
  return (
    <p className="mx-auto flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
      fewer
      <svg width="110" height="12" aria-hidden>
        {steps.map((t, i) => (
          <rect
            key={t}
            x={i * 22}
            width={20}
            height={12}
            rx={2}
            className="story-cell"
            style={{ "--cl": rampColor(t, "light").bg, "--cd": rampColor(t, "dark").bg } as React.CSSProperties}
          />
        ))}
      </svg>
      more detections (log scale)
    </p>
  );
}

function Chapter({
  id, n, kicker, title, children, figure, className,
}: {
  id: string; n: number; kicker: string; title: React.ReactNode; children: React.ReactNode; figure?: React.ReactNode; className?: string;
}) {
  return (
    <section
      id={id}
      data-chapter
      aria-labelledby={`${id}-h`}
      className={cn("grid min-h-[85svh] scroll-mt-16 content-center gap-10 border-t py-20 md:grid-cols-12 md:gap-12", className)}
    >
      <div className="story-reveal story-text flex flex-col gap-5 md:col-span-5">
        <p className="kicker">
          {String(n).padStart(2, "0")} · {kicker}
        </p>
        <h2 id={`${id}-h`} className="max-w-[18ch] text-3xl leading-[0.92] text-balance md:text-[42px]">
          {title}
        </h2>
        <div className="flex max-w-[52ch] flex-col gap-4 text-base leading-[1.65] text-muted-foreground">{children}</div>
      </div>
      {figure && <div className="story-reveal story-figure md:col-span-7">{figure}</div>}
    </section>
  );
}

export default function StoryPage() {
  const s = loadStory();
  const span = recordSpan();
  // FE-029: whole countries (ML-026) are on the site too; the opening line names them once they are published
  const countries = REGION_LIST.filter((r) => r.tier === "country").length;
  const { modis, viirs, gapMinutes, ratio, frame } = s.fire;
  const area = (PIXEL_M.modis / PIXEL_M.viirs) ** 2;
  const total = s.counts.reduce((a, c) => a + c.rows, 0);
  const top = [...s.counts].sort((a, b) => b.rows - a.rows)[0];
  const [h0, h1] = s.holdout;
  const record = `/record?region=${s.region.id}`;
  const terraSince = s.counts.map((c) => c.since).sort()[0];
  const sat = (p: { satellite: string }) => SAT[p.satellite] ?? p.satellite;

  return (
    <div data-story-shell className="story-shell relative w-full">
      <StorySceneGate />
      <main data-story className="relative z-10 mx-auto flex w-full max-w-6xl flex-col px-4 sm:px-6">
        <StoryMotion />

        {/* 1 · title */}
        <section data-chapter aria-labelledby="story-title" className="flex min-h-[calc(100svh-4rem)] flex-col justify-center gap-8 py-16">
          <div className="story-reveal story-text flex flex-col gap-6">
            <p className="kicker">
              01 · NASA satellite fire detections, {span.first} to {dayLabel(span.through)}
            </p>
            <h1 id="story-title" className="max-w-[14ch] text-5xl leading-[0.92] text-balance md:text-[80px]">
              Fire belongs here. What changes is how much, and when.
            </h1>
            <p className="max-w-[58ch] text-lg leading-[1.65] text-muted-foreground">
              NASA&apos;s MODIS instruments have watched for fire from orbit since {monthYear(terraSince)}, and VIIRS since{" "}
              {VIIRS_FROM}. They count it differently, so the record breaks in {VIIRS_FROM}. One Fire Record mends it for{" "}
              {countries > 0 ? `${countries} whole countries (labelled where it is only an estimate), and in detail for ${span.regions}.` : `${span.regions}.`}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/record" className={primaryLink}>
                Skip to the data
                <ArrowRightIcon className="size-4" aria-hidden />
              </Link>
              <a href="#counts" className={quietLink}>
                Read the story
                <ArrowDownIcon className="size-4" aria-hidden />
              </a>
            </div>
            {/* shown only while the scroll scene is on (globals.css); it keeps its line either way, so nothing moves */}
            <p className="story-scene-note max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
              Behind this page: the hills of central Portugal from NASA SRTM elevation, and the{" "}
              {s.scene.detections.toLocaleString("en-US")} fire detections NASA satellites made there in {s.scene.year}. As you
              scroll they light in date order from the night of the Pedrógão Grande fire, stack up day by day, then
              settle into Portugal&apos;s month-by-month record.
            </p>
          </div>
        </section>

        {/* 2 · counts */}
        <Chapter
          id="counts"
          n={2}
          kicker="What the satellites saw"
          title={
            <>
              {bigCount(top.rows)} fire detections in {top.name} alone since {monthYear(top.since)}.
            </>
          }
          figure={
            <dl className="grid gap-px overflow-hidden border bg-border">
              {s.counts.map((c) => (
                <div key={c.id} className="flex items-baseline justify-between gap-4 bg-background px-5 py-5">
                  <dt className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">{c.name}</dt>
                  <dd className="font-mono text-3xl font-semibold tracking-tight tabular-nums [text-shadow:0_0_18px_color-mix(in_oklch,var(--primary)_45%,transparent)] md:text-4xl">
                    <span aria-hidden data-count={c.rows}>{c.rows.toLocaleString("en-US")}</span>
                    <span className="sr-only">{c.rows.toLocaleString("en-US")}</span>
                  </dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 bg-card px-5 py-4 font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
                <dt>All three, to {dayLabel(top.through)}</dt>
                <dd className="font-mono tabular-nums">{total.toLocaleString("en-US")}</dd>
              </div>
            </dl>
          }
        >
          <p>
            Each detection is one hot pixel seen from orbit: a satellite passing overhead found a spot burning hotter than
            the ground around it. NASA FIRMS keeps every one.
          </p>
        </Chapter>

        {/* 3 · same fire, two answers */}
        <Chapter
          id="two-answers"
          n={3}
          kicker={`${STORY_FIRE.place}, ${longDay(STORY_FIRE.date)}`}
          title="Same fire, two answers."
          figure={<FireFootprints modis={modis} viirs={viirs} frame={frame} />}
        >
          <p>
            The day after the Pedrógão Grande fire started, {sat(modis)} passed over the fires around it and counted{" "}
            <strong className="font-semibold text-primary">{modis.points.length}</strong> hot pixels. {gapMinutes} minutes
            later, {sat(viirs)} counted <strong className="font-semibold text-primary">{viirs.points.length}</strong>.
          </p>
          <p>
            Nothing burned {ratio.toFixed(1)} times faster in between. A VIIRS pixel is {PIXEL_M.viirs} m across, a MODIS
            pixel 1 km, so one MODIS square covers about {Math.round(area)} VIIRS squares, and VIIRS also catches smaller
            fires. That mostly explains the gap. Every square in the panels is a real detection, drawn at its nominal size.
          </p>
        </Chapter>

        {/* 4 · raw line */}
        <Chapter
          id="the-leap"
          n={4}
          kicker={`${s.region.name}, yearly detections`}
          title={
            <>
              Fire did not {jumpVerb(s.region.jump)}. The instrument changed.
            </>
          }
          figure={
            <div className="flex flex-col gap-3">
              <StoryLine
                lines={s.lines}
                mode="raw"
                label={`${s.region.name}, detections per year, ${s.lines.years[0]} to ${s.lines.years.at(-1)}, MODIS then VIIRS: the yearly count averages about ×${s.region.jump.toFixed(1)} higher from ${VIIRS_FROM} than before it.`}
              />
              <StoryLegend mode="raw" />
            </div>
          }
        >
          <p>
            Glue the MODIS years to the VIIRS years and {s.region.name}&apos;s yearly count averages about ×
            {s.region.jump.toFixed(1)} higher from {VIIRS_FROM}, the year VIIRS starts, than before it. Any chart that
            stitches the two records shows fire getting worse, and part of that rise is the sensor, not the fire.
          </p>
        </Chapter>

        {/* 5 · harmonized */}
        <Chapter
          id="one-record"
          n={5}
          kicker="Harmonized"
          title="One record, with honest error bars."
          figure={
            <div className="flex flex-col gap-3">
              <StoryLine
                lines={s.lines}
                mode="harmonized"
                label={`${s.region.name}, detections per year in VIIRS terms, ${s.lines.years[0]} to ${s.lines.years.at(-1)}, with a 5-95% band on the years before ${VIIRS_FROM}: no jump.`}
              />
              <StoryLegend mode="harmonized" />
            </div>
          }
        >
          <p>
            We learned how MODIS maps to VIIRS in the years both flew, {VIIRS_FROM} to {HOLD_FROM - 1}, then translated
            every MODIS year into VIIRS terms, with a 5-95% band.
          </p>
          <p>
            Tested on {h0} to {h1}, years the model never saw, it missed by{" "}
            <strong className="font-semibold text-primary">{s.score.mape_model.toFixed(1)}%</strong> a year on average,
            against {s.score.mape_ratio.toFixed(1)}% for one constant factor; {s.score.coverage} of {s.score.n_hold} years
            fell inside the band.
          </p>
        </Chapter>

        {/* 6 · calendar, hand-off */}
        <Chapter
          id="calendar"
          n={6}
          kicker={`${s.region.name}, every month`}
          title={`Every month since ${s.grid.years[0]}, on one scale.`}
          className="border-b-0"
          figure={
            <div className="flex flex-col gap-3">
            <StoryCalendar
              grid={s.grid}
              label={`${s.region.name} burn calendar: harmonized detections per month, one row per year from ${s.grid.years[0]} to ${s.grid.years.at(-1)}, darker or brighter cells for more fire.`}
            />
            <CalendarKey />
            </div>
          }
        >
          <p>
            {FIRE_SEASON[s.region.id]} With the break mended, this month can be held up against every month before it, and
            the busiest years stand out for what burned, not for which satellite looked.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link href={record} className={primaryLink}>
              Open the record
              <ArrowRightIcon className="size-4" aria-hidden />
            </Link>
            <Link href={`/calendar?region=${s.region.id}`} className={quietLink}>
              Open the calendar
            </Link>
            <Link href="/method" className={quietLink}>
              How it works
            </Link>
          </div>
        </Chapter>
      </main>
    </div>
  );
}
