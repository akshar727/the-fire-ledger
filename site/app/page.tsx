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
import { FEATURE_TILES } from "@/lib/features";
import { recordSpan } from "@/lib/data-server";
import { FIRE_SEASON } from "@/lib/regions";
import { rampColor } from "@/lib/series";
import { bigCount, jumpVerb, PIXEL_M, STORY_FIRE } from "@/lib/story";
import { loadStory } from "@/lib/story-data";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: { absolute: "Fire Ledger" } };

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const monthYear = (iso: string) =>
  `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const primaryLink = "btn-console";
const quietLink = "btn-quiet";

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
            style={
              {
                "--cl": rampColor(t, "light").bg,
                "--cd": rampColor(t, "dark").bg,
              } as React.CSSProperties
            }
          />
        ))}
      </svg>
      more detections (log scale)
    </p>
  );
}

function Chapter({
  id,
  n,
  title,
  children,
  figure,
  className,
}: {
  id: string;
  n: number;
  title: React.ReactNode;
  children: React.ReactNode;
  figure?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-chapter
      aria-labelledby={`${id}-h`}
      className={cn(
        "grid min-h-[85svh] scroll-mt-16 content-center gap-10 border-t py-20 md:grid-cols-12 md:gap-12",
        className,
      )}
    >
      <div className="story-reveal story-text flex flex-col gap-5 md:col-span-5">
        <h2
          id={`${id}-h`}
          className="max-w-[18ch] text-3xl leading-[0.92] text-balance md:text-[42px]"
        >
          {title}
        </h2>
        <div className="flex max-w-[52ch] flex-col gap-4 text-base leading-[1.65] text-muted-foreground">
          {children}
        </div>
      </div>
      {figure && (
        <div className="story-reveal story-figure md:col-span-7">{figure}</div>
      )}
    </section>
  );
}

export default function StoryPage() {
  const s = loadStory();
  const span = recordSpan();
  const countries = REGION_LIST.filter((r) => r.tier === "country").length;
  const { modis, viirs, gapMinutes, ratio, frame } = s.fire;
  const area = (PIXEL_M.modis / PIXEL_M.viirs) ** 2;
  const total = s.counts.reduce((a, c) => a + c.rows, 0);
  const top = [...s.counts].sort((a, b) => b.rows - a.rows)[0];
  const [h0, h1] = s.holdout;
  const record = `/ledger?region=${s.region.id}`;
  const terraSince = s.counts.map((c) => c.since).sort()[0];
  const sat = (p: { satellite: string }) => SAT[p.satellite] ?? p.satellite;

  return (
    <div data-story-shell className="story-shell relative w-full">
      <StorySceneGate />
      <main
        data-story
        className="relative z-10 mx-auto flex w-full max-w-6xl flex-col px-4 sm:px-6"
      >
        <StoryMotion />

        <section
          data-chapter
          aria-labelledby="story-title"
          className="flex min-h-[calc(100svh-4rem)] flex-col justify-center gap-8 py-16"
        >
          <div className="story-reveal story-text flex flex-col gap-6">
            <h1
              id="story-title"
              className="max-w-[14ch] text-5xl leading-[0.92] text-balance md:text-[80px]"
            >
              Fire is everywhere. What changes is how much, and when.
            </h1>
            <p className="max-w-[58ch] text-lg leading-[1.65] text-muted-foreground">
              NASA used its MODIS instruments up to 2012, and then VIIRS from
              2012 on. These two see fire very differently, so the record of
              fire detections breaks in 2012. Fire Ledger unites the two records
              into one ledger for{" "}
              {countries > 0
                ? `${countries} whole countries (labelled where it is only an estimate), and in detail for ${span.regions}.`
                : `${span.regions}.`}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/ledger" className={primaryLink}>
                See the data
                <ArrowRightIcon className="size-4" aria-hidden />
              </Link>
              <a href="#counts" className={quietLink}>
                Read the story
                <ArrowDownIcon className="size-4" aria-hidden />
              </a>
            </div>
            <nav aria-label="What you can do here">
              <ul className="grid gap-px overflow-hidden border bg-border sm:grid-cols-2 lg:grid-cols-3">
                {FEATURE_TILES.map((t) => (
                  <li key={t.tag} className="flex">
                    <Link
                      href={t.href}
                      className="group flex w-full flex-col gap-1.5 bg-background px-4 py-4 transition-colors hover:bg-card focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                    >
                      <span className="flex items-start justify-between gap-3 text-base leading-snug font-medium text-foreground">
                        {t.title}
                        <ArrowRightIcon
                          className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                          aria-hidden
                        />
                      </span>
                      <span className="text-sm leading-relaxed text-muted-foreground">
                        {t.text}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <p className="story-scene-note max-w-[70ch] text-sm leading-relaxed text-muted-foreground">
              The animation behind this page takes you through the hills of
              central Portugal from NASA SRTM elevation, and the{" "}
              {s.scene.detections.toLocaleString("en-US")} fire detections NASA
              satellites made there in {s.scene.year}. As you read the story,
              the detections light up in order from the night of the Pedrógão
              Grande fire.
            </p>
          </div>
        </section>

        <Chapter
          id="counts"
          n={2}
          title={
            <>
              {bigCount(top.rows)} fire detections in {top.name} alone since{" "}
              {monthYear(top.since)}.
            </>
          }
          figure={
            <dl className="grid gap-px overflow-hidden border bg-border">
              {s.counts.map((c) => (
                <div
                  key={c.id}
                  className="flex items-baseline justify-between gap-4 bg-background px-5 py-5"
                >
                  <dt className="font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
                    {c.name}
                  </dt>
                  <dd className="font-mono text-3xl font-semibold tracking-tight tabular-nums [text-shadow:0_0_18px_color-mix(in_oklch,var(--primary)_45%,transparent)] md:text-4xl">
                    <span aria-hidden data-count={c.rows}>
                      {c.rows.toLocaleString("en-US")}
                    </span>
                    <span className="sr-only">
                      {c.rows.toLocaleString("en-US")}
                    </span>
                  </dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 bg-card px-5 py-4 font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
                <dt>All three, through {dayLabel(top.through)}</dt>
                <dd className="font-mono tabular-nums">
                  {total.toLocaleString("en-US")}
                </dd>
              </div>
            </dl>
          }
        >
          <p>
            Each detection is a hot pixel seen from orbit. It means that a
            satellite passing over it found a spot burning hotter than the
            surface around it. NASA FIRMS records and shares all of these
            detections publically.
          </p>
        </Chapter>

        <Chapter
          id="two-answers"
          n={3}
          title="Same fire, two answers."
          figure={<FireFootprints modis={modis} viirs={viirs} frame={frame} />}
        >
          <p>
            The day after the Pedrógão Grande fire started, {sat(modis)} passed
            over the fires around it and counted{" "}
            <strong className="font-semibold text-primary">
              {modis.points.length}
            </strong>{" "}
            hot pixels. {gapMinutes} minutes later, {sat(viirs)} passed over the
            fires and counted{" "}
            <strong className="font-semibold text-primary">
              {viirs.points.length}
            </strong>
            .
          </p>
          <p>
            The fire didn't burn {ratio.toFixed(1)} times faster in between; the
            difference comes from sensor resolution. A VIIRS pixel is{" "}
            {PIXEL_M.viirs} m across, while a MODIS pixel is 1 km across, so a
            MODIS square covers about {Math.round(area)} VIIRS squares, and
            VIIRS also catches smaller fires. This helps explain the gap in the
            records.
          </p>
        </Chapter>

        <Chapter
          id="the-leap"
          n={4}
          title={
            <>
              The fire didn't {jumpVerb(s.region.jump)}. The instrument got
              better.
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
            Mesh the MODIS years to the VIIRS years, and {s.region.name}&apos;s
            yearly count averages about {s.region.jump.toFixed(1)}x higher from{" "}
            {VIIRS_FROM}, when VIIRS starts recording data, than before it.
            Stitching the two records shows the fire getting worse, and part of
            that rise is the sensor, not the fire itself.
          </p>
        </Chapter>

        <Chapter
          id="one-ledger"
          n={5}
          title="One unified ledger with error bars."
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
            We coded a model to learn how MODIS maps to VIIRS in the years both
            flew – {VIIRS_FROM} to {HOLD_FROM - 1} – and then translated every
            MODIS year into the VIIRS scale with a 5-95% error band.
          </p>
          <p>
            Tested on {h0} to {h1}, years the model wasn't trained on, it
            missed, on average, by{" "}
            <strong className="font-semibold text-primary">
              {s.score.mape_model.toFixed(1)}%
            </strong>{" "}
            yearly, against {s.score.mape_ratio.toFixed(1)}% for a constant
            ratio. {s.score.coverage} of the {s.score.n_hold} tested years fell
            inside the error band, showing the model's accuracy.
          </p>
        </Chapter>

        <Chapter
          id="calendar"
          n={6}
          title={`Every month since ${s.grid.years[0]} on one scale.`}
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
            In the grid to the right is the {FIRE_SEASON[s.region.id]} With the
            break mended, these months can be held up against every month before
            it, and the busiest years stand out for what burned, regardless of
            which satellite scanned.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link href={record} className={primaryLink}>
              Open the ledger
              <ArrowRightIcon className="size-4" aria-hidden />
            </Link>
            <Link
              href={`/calendar?region=${s.region.id}`}
              className={quietLink}
            >
              Open the calendar
            </Link>
            <Link href="/method" className={quietLink}>
              How it works
            </Link>
          </div>
          <p className="pt-1 text-sm">
            <Link
              href="/globe"
              className="underline underline-offset-4 hover:text-primary"
            >
              See every place on the globe
            </Link>
            , coloured by its fire ledger from 2001.
          </p>
        </Chapter>
      </main>
    </div>
  );
}
