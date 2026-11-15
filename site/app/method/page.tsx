import type { Metadata } from "next";
import Link from "next/link";
import { dayLabel, HOLD_FROM, holdoutYears, isPartial, VIIRS_FROM, type Annual, type ForwardScore } from "@/lib/annual";
import { loadReferee, REGION_LIST, REGIONS } from "@/lib/data";
import { readAnnual as loadAnnual, recordSpan } from "@/lib/data-server";
import { backcastOffset, nearLevel, stepLabel, stepRange } from "@/lib/referee";
import { SAT } from "@/components/story/FireFootprints";
import { PIXEL_M, SCENE_BBOX, STORY_FIRE, utc } from "@/lib/story";
import { loadStory } from "@/lib/story-data";
import { boardSentence, LABEL_TEXT, LABELS, scoreRow, summarize, type ScoreSource } from "@/lib/scoreboard";
import { WorldScoreboard } from "@/components/WorldScoreboard";

export const metadata: Metadata = { title: "Method" };

const SECTIONS = [
  { id: "scene", title: "The opening scene" },
  { id: "problem", title: "The problem" },
  { id: "harmonization", title: "How the conversion works" },
  { id: "holdout", title: "What the hold-out shows" },
  { id: "scoreboard", title: "The world scoreboard" },
  { id: "referee", title: "An independent check" },
  { id: "caveats", title: "Known limits" },
  { id: "sources", title: "Sources" },
] as const;

const ARCHIVE_URL = "https://firms.modaps.eosdis.nasa.gov/country/";
const AREA_API_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/";

// Every region, in index.json order, with its annual record (scores, years) and display name. DP-009: the cell regions
// make up the main text and table; whole countries get their own table under the hold-out.
const ALL = REGION_LIST.map((r) => ({ id: r.id, name: REGIONS[r.id], D: loadAnnual(r.id), through: r.data_through, tier: r.tier }));
const RECORDS = ALL.filter((r) => r.tier === "region");
const COUNTRY_RECORDS = ALL.filter((r) => r.tier === "country");
const SPAN = recordSpan();
// FE-028: every record's own hold-out check, deep dives first, then whole countries (index.json order)
const SCORE_ROWS = ALL.map((r) => scoreRow(r.id, r.name, r.tier === "country", r.D as unknown as ScoreSource));
const BOARD = summarize(SCORE_ROWS);
const REF = loadReferee();
// End of the downloaded record (index.json archive_through, the same for every region), e.g. 2026-11-02.
const THROUGH = RECORDS.map((r) => r.through).sort().at(-1)!;
const ARCHIVE_END = Number(THROUGH.slice(0, 4)) - 1; // yearly archives run to the year before the area API takes over

// FE-019: the landing page's scroll scene, described from the same files it is drawn from
const STORY = loadStory();
const deg = (v: number, pos: string, neg: string) => `${Math.abs(v)}° ${v >= 0 ? pos : neg}`;
const SCENE_AREA = `${deg(SCENE_BBOX.s, "N", "S")} to ${deg(SCENE_BBOX.n, "N", "S")}, ${deg(SCENE_BBOX.w, "E", "W")} to ${deg(SCENE_BBOX.e, "E", "W")}`;

const pct = (v: number) => `${v.toFixed(1)}%`;
// FE-009: regions whose annual.json carries the NOAA-20/21 forward link (ML-017), with its hold-out score
const FORWARD = RECORDS.flatMap((r) => (r.D.score.forward && r.D.forward_through ? [{ ...r, F: r.D.score.forward }] : []));
const span = ([a, b]: string[]) => `${dayLabel(a)} to ${dayLabel(b)}`;
const forwardText = (name: string, F: ForwardScore) =>
  `${name} ${pct(F.mape_month)} (one constant ratio: ${pct(F.mape_ratio_month)}; ${F.coverage_month} of ${F.n_month} months inside the band)`;
const coverageText = (D: Annual) => `${D.score.coverage} of ${D.score.n_hold}`;

const DATA_SOURCES = [
  {
    name: `NASA FIRMS, MODIS Collection 6.1 active fire (Terra and Aqua), country yearly archives, 2000 to ${ARCHIVE_END}`,
    url: ARCHIVE_URL,
  },
  {
    name: `NASA FIRMS, VIIRS 375 m active fire (Suomi NPP), country yearly archives, ${VIIRS_FROM} to ${ARCHIVE_END}`,
    url: ARCHIVE_URL,
  },
  {
    name: `NASA FIRMS area API, MODIS (MODIS_SP, then MODIS_NRT), 1 Jan to ${dayLabel(THROUGH)}, each region's box`,
    url: AREA_API_URL,
  },
  {
    name: `NASA FIRMS area API, VIIRS Suomi NPP (VIIRS_SNPP_SP, then VIIRS_SNPP_NRT), 1 Jan to ${dayLabel(THROUGH)}, each region's box`,
    url: AREA_API_URL,
  },
  ...(FORWARD.length > 0
    ? [
        {
          name: `NASA FIRMS, VIIRS 375 m active fire (NOAA-20), country yearly archives from April 2018, and the area API (VIIRS_NOAA20_SP, then _NRT) to ${dayLabel(FORWARD[0].D.forward_through!)}`,
          url: "https://doi.org/10.5067/VIIRS/VJ114IMG.002",
        },
        {
          name: `NASA FIRMS area API, VIIRS 375 m active fire (NOAA-21, VIIRS_NOAA21_SP, then _NRT), 1 Jan 2024 to ${dayLabel(FORWARD[0].D.forward_through!)}`,
          url: "https://doi.org/10.5067/VIIRS/VJ214IMG.002",
        },
      ]
    : []),
  {
    name: `NASA SRTM GL3 elevation (about 90 m), ${SCENE_AREA}, for the landing-page scene`,
    url: "https://doi.org/10.5067/MEASURES/SRTM/SRTMGL3.003",
  },
  {
    name: `MODIS burned area, ${REF.product_short}, 0.25° monthly (University of Maryland), for the independent check`,
    url: "https://doi.org/10.5067/MODIS/MCD64A1.006",
  },
];

const SOFTWARE = [
  ["numpy, pandas, statsmodels, patsy, scipy", "Gridding, model fitting and bootstrap (Python)"],
  ["pyhdf", "Reading the burned-area files (Python, one-off extract)"],
  ["Next.js, React", "This website"],
  ["Tailwind CSS, shadcn/ui, Radix UI", "Styling and interface components"],
  ["Phosphor Icons, Work Sans, IBM Plex Mono", "Icons and typefaces"],
  ["Blender", "Rendering the landing-page scene"],
] as const;

export default function MethodPage() {
  const [h0, h1] = holdoutYears(RECORDS[0].D);
  const losers = RECORDS.filter((r) => r.D.score.mape_model >= r.D.score.mape_ratio);
  const sigmas = RECORDS.map((r) => Math.round(r.D.score.sigma_year * 100)).sort((a, b) => a - b);
  const sigmaRange = sigmas[0] === sigmas.at(-1) ? `${sigmas[0]}%` : `${sigmas[0]}% to ${sigmas.at(-1)}%`;
  const narrow = RECORDS.some((r) => r.D.score.coverage < r.D.score.n_hold - 1);
  const last = RECORDS[0].D;
  const lastYear = last.years.at(-1)!;
  const lastPartial = isPartial(last, last.years.length - 1);
  const coverage = RECORDS.map((r, i) => `${coverageText(r.D)}${i === 0 ? " hold-out years" : ""} in ${r.name}`);
  const coverageList = coverage.length > 1 ? `${coverage.slice(0, -1).join(", ")} and ${coverage.at(-1)}` : coverage[0];
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-12 pb-20 sm:px-6 md:grid-cols-[13rem_1fr] md:gap-16 md:pt-16">
      <aside className="md:sticky md:top-24 md:self-start">
        <nav aria-label="On this page" className="flex flex-col gap-1 border-l text-sm">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="-ml-px border-l border-transparent py-1 pl-4 text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              {s.title}
            </a>
          ))}
        </nav>
      </aside>

      <article className="flex max-w-[68ch] min-w-0 flex-col gap-12 leading-relaxed [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:text-muted-foreground [&_section]:flex [&_section]:scroll-mt-24 [&_section]:flex-col [&_section]:gap-4">
        <header className="flex flex-col gap-4">
          <h1 className="text-4xl leading-[1.05] font-bold tracking-tight md:text-5xl">Method</h1>
          <p className="text-lg">
            How we turn two satellite fire records into one, and how far the result can be trusted.
          </p>
        </header>

        <section id="scene">
          <h2>The opening scene</h2>
          <p>
            On a wide screen, the{" "}
            <Link className="underline underline-offset-2 hover:text-foreground" href="/">
              landing page
            </Link>{" "}
            scrolls over a 3D scene: hills at sunset, a fire on the ridge ahead, two satellites passing overhead, then
            thousands of small squares that fall into a calendar. It is not a made-up landscape. It is a real place on
            a real day, built from the same NASA data as the rest of this site.
          </p>
          <p>
            <span className="font-medium text-foreground">The fire is the Pedrógão Grande fire</span> in central
            Portugal, which started on 17 June {STORY.scene.year}. The scene opens at the end of that afternoon, looking
            at the hills where it burned. On {dayLabel(STORY_FIRE.date)}, {SAT[STORY.fire.modis.satellite] ?? STORY.fire.modis.satellite}{" "}
            passed over at {utc(STORY.fire.modis.time)} and recorded {STORY.fire.modis.points.length} hot pixels there;{" "}
            {STORY.fire.gapMinutes} minutes later {SAT[STORY.fire.viirs.satellite] ?? STORY.fire.viirs.satellite}{" "}
            recorded {STORY.fire.viirs.points.length}. Those are the two passes the scene shows, each square appearing
            under the scan line of the satellite that made it.
          </p>
          <p>
            <span className="font-medium text-foreground">The ground is real.</span> The terrain is NASA Shuttle Radar
            Topography Mission elevation (SRTM, about 90 m) for {SCENE_AREA}, the area around the fire. Heights are
            stretched 2.5 times so the hills read from far above.
          </p>
          <p>
            <span className="font-medium text-foreground">Every square is a real detection.</span> As you scroll, all{" "}
            {STORY.scene.detections.toLocaleString("en-US")} FIRMS fire detections in that area in {STORY.scene.year}{" "}
            switch on in date order at the place they were seen, each drawn at its sensor&apos;s pixel size (MODIS{" "}
            {PIXEL_M.modis / 1000} km, VIIRS {PIXEL_M.viirs} m). They then stack into one column per day of the year,
            and finally settle into a 26-year by 12-month grid in proportion to Portugal&apos;s harmonized monthly
            record, the one described below.
          </p>
          <p>
            <span className="font-medium text-foreground">What is decoration.</span> The trees, grass, smoke, embers,
            clouds, sky, sun and the satellite models are simple shapes drawn by our script to make the place readable;
            they carry no data. The frames are rendered in Blender from this project&apos;s own files, with no
            imported models, textures or AI-generated images. On small screens, or with reduced motion turned on, the
            scene is left out and the page tells the same story with plain charts.
          </p>
        </section>

        <section id="problem">
          <h2>The problem</h2>
          <p>
            NASA FIRMS reports active fires seen by MODIS (Terra since 2000, Aqua since mid-2002) and by VIIRS (Suomi
            NPP since {VIIRS_FROM}). VIIRS pixels are 375 m against MODIS&apos;s 1 km, so VIIRS sees more and smaller
            fires. Joining the two records at {VIIRS_FROM} creates a jump in detections that is about the sensor, not
            about fire.
          </p>
        </section>

        <section id="harmonization">
          <h2>How the conversion works</h2>
          <p>
            We keep presumed vegetation fires (FIRMS type 0) in each of our regions, {SPAN.regions}, and count detections per 0.25°
            grid cell, per week, separately for day and night passes. Every cell that ever burned gets a row for every
            week, so weeks where MODIS saw nothing are modelled too.
          </p>
          <p>
            For {VIIRS_FROM}-{HOLD_FROM - 1}, when both sensors flew, a Poisson regression learns the VIIRS count in
            each cell-week from what MODIS saw there: Terra and Aqua counts, their mean fire radiative power, total
            MODIS activity across the region that week, and the month, latitude band and day or night. Each region
            gets its own fit. Applied to {SPAN.first}-{VIIRS_FROM - 1}, it gives a VIIRS-equivalent count for years
            before VIIRS existed. Summed over the year, that is the harmonized line. From {VIIRS_FROM} on, the
            harmonized line is the observed VIIRS count; only the first weeks of {VIIRS_FROM}, before VIIRS data
            starts on 20 January, are filled in by the model.
          </p>
          <p>
            The band shows the 5th to 95th percentile of 200 simulated yearly totals. Each simulation refits the model
            on training years drawn with replacement, scales each year up or down by one shared random factor, then
            adds count noise from a negative binomial distribution. The yearly factor is sized from how far off the
            model was for each training year when that year was left out of the fit ({sigmaRange}, depending on the
            region), so the band covers model uncertainty, whole-year departures and count noise.
          </p>
        </section>

        <section id="holdout">
          <h2>What the hold-out shows</h2>
          <p>
            We never fit on {HOLD_FROM} or later. Each region&apos;s model predicts the complete years {h0}-{h1} from
            MODIS alone, and we compare that with what VIIRS actually saw. The baseline is the simplest possible
            conversion: one constant VIIRS-to-MODIS factor per region, taken from the same training years.
          </p>
          <ScoreTable records={RECORDS} caption="Hold-out scores per region" />
          {losers.length > 0 && (
            <p>
              {losers.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && " "}
                  In {r.name} the model loses: a single constant factor of {r.D.score.ratio.toFixed(2)} predicts the
                  hold-out years better ({pct(r.D.score.mape_ratio)} error against the model&apos;s{" "}
                  {pct(r.D.score.mape_model)}), so the hold-out gives no evidence that the model&apos;s back-cast there
                  beats the simple conversion.
                </span>
              ))}
            </p>
          )}
          {COUNTRY_RECORDS.length > 0 && (
            <>
              <h3 id="countries" className="text-base font-semibold text-foreground">
                Whole countries: whole-country runs of the same model
              </h3>
              <p>
                The same model and the same test, run on every fire in a whole country instead of a box. Country records
                end with the FIRMS yearly archive ({dayLabel(COUNTRY_RECORDS[0].through)}), so they have no forward link,
                no per-detection download, no weather and no burned-area check.
              </p>
              <p>
                Every country&apos;s own scores are in{" "}
                <a className="underline underline-offset-2 hover:text-foreground" href="#scoreboard">
                  the world scoreboard
                </a>{" "}
                below.
              </p>
            </>
          )}
          {FORWARD.length > 0 && (
            <p id="forward-link">
              <span className="font-medium text-foreground">After Suomi NPP.</span> The Suomi NPP record ends on{" "}
              {dayLabel(FORWARD[0].D.data_through)}. NOAA-20 and NOAA-21 carry the same VIIRS instrument in the same
              orbit, about 50 minutes apart, so a second, much smaller model carries the record on: one ratio per region
              and day or night pass that turns their detections into Suomi-NPP-equivalent counts, fitted on{" "}
              {span(FORWARD[0].F.train)} and tested on {span(FORWARD[0].F.hold)}, where Suomi NPP is there to check
              against. On the months of that test with at least {FORWARD[0].F.min_month} detections, its mean monthly
              error is {FORWARD.map((r) => forwardText(r.name, r.F)).join(", ")}.{" "}
              {FORWARD.filter((r) => r.F.mape_month >= r.F.mape_ratio_month).length > 0 &&
                `In ${FORWARD.filter((r) => r.F.mape_month >= r.F.mape_ratio_month)
                  .map((r) => r.name)
                  .join(" and ")} the simple NOAA-20 ratio does as well, so the link adds little there beyond using both NOAA satellites. `}
              Days after {dayLabel(FORWARD[0].D.data_through, false)}, up to{" "}
              {dayLabel(FORWARD[0].D.forward_through!)}, are marked in the calendar with a bar and in the record chart
              with a dashed stem; the month still running is compared only with the same days of other years.
            </p>
          )}
          <p>
            This is a forward test: it shows whether the model carries over to later years. It cannot directly prove
            accuracy for {SPAN.first}-{VIIRS_FROM - 1}, because no VIIRS data exists then to check against; the next
            section checks those years against a different satellite product instead.
          </p>
        </section>

        <section id="scoreboard">
          <h2>The world scoreboard</h2>
          <p>{boardSentence(BOARD)}</p>
          <WorldScoreboard rows={SCORE_ROWS} />
          <dl className="grid gap-x-4 gap-y-1 text-sm text-muted-foreground sm:grid-cols-[auto_1fr]">
            {LABELS.map((l) => (
              <div key={l} className="contents">
                <dt className="font-medium text-foreground">{l}</dt>
                <dd>{LABEL_TEXT[l]}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            Errors are the mean absolute percentage error of the yearly totals over the complete hold-out years
            ({HOLD_FROM} on), as in the table above; the smaller of the two is in bold. Big countries use coarser cells
            so the model runs on as many countries as possible; the rest get the fixed-ratio estimate (label ratio).
          </p>
        </section>

        <section id="referee">
          <h2>An independent check</h2>
          <p>
            The hold-out cannot test {SPAN.first}-{VIIRS_FROM - 1} directly. MODIS burned area (MCD64) can help: it
            maps the land that burned each month from 2000 on with one method throughout, so it has no {VIIRS_FROM}{" "}
            sensor switch. If the harmonized record is right, fire detections per square kilometre burned should stay
            about level across {VIIRS_FROM}; the stitched record (MODIS counts, then VIIRS counts) should jump. We sum
            burned area over exactly the grid cells the model uses and compare {REF.before[0]}-{REF.before[1]} with{" "}
            {REF.after[0]}-{REF.after[1]}.
          </p>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">
                Detections per 1,000 km² burned, {REF.after[0]}-{REF.after[1]} divided by {REF.before[0]}-
                {REF.before[1]}
              </caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    After / before {VIIRS_FROM}
                  </th>
                  {RECORDS.map((r) => (
                    <th key={r.id} scope="col" className="px-3 py-2 font-medium">
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y text-muted-foreground tabular-nums">
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Stitched record
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                      {stepLabel(REF.regions[r.id]?.stitched.step ?? null)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Harmonized record
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 font-medium whitespace-nowrap text-foreground">
                      {stepLabel(REF.regions[r.id]?.harmonized.step ?? null)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Monthly correlation with burned area, harmonized (before / after)
                  </th>
                  {RECORDS.map((r) => {
                    const h = REF.regions[r.id]?.harmonized;
                    return (
                      <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                        {h?.monthly_r_before?.toFixed(2) ?? "n/a"} / {h?.monthly_r_after?.toFixed(2) ?? "n/a"}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Across {VIIRS_FROM}, detections per area burned jump{" "}
            {stepRange(RECORDS.map((r) => REF.regions[r.id]?.stitched.step ?? null))} in the stitched record and move{" "}
            {stepRange(RECORDS.map((r) => REF.regions[r.id]?.harmonized.step ?? null))} in the harmonized record.{" "}
            {RECORDS.every((r) => REF.regions[r.id] && nearLevel(REF.regions[r.id]))
              ? "In every region the harmonized record stays within 25% of level and much closer to it than the stitched record, which is consistent with the back-cast removing the sensor jump."
              : "Not every region's harmonized record stays within 25% of level, so this check only partly supports the back-cast."}
          </p>
          <p>
            Detections per area burned in the back-cast years compared with the observed VIIRS years:{" "}
            {RECORDS.map((r) => `${r.name} ${backcastOffset(REF.regions[r.id]?.harmonized.step ?? null) ?? "n/a"}`).join(
              ", ",
            )}
            . A plus means the back-cast may run that much high, a minus that much low; part of it can also be real, as
            fires can change in size or type over two decades.
          </p>
          <p>
            Limits: burned area is mapped partly with the help of MODIS active fires, so it is independent of VIIRS and
            of our model but not entirely of MODIS. It misses many small fires, especially crop-residue burns, so
            absolute values per area are rough; the before/after ratio is fairer because the same product is used on
            both sides. Some months could not be fully mapped (clouds, smoke, missing passes), which lowers burned area in those months. The monthly correlation in the table compares the back-cast with a product that also uses MODIS, so it shows consistency, not proof. The available burned-area files end in{" "}
            {REF.after[1]}.
          </p>
        </section>

        <section id="caveats">
          <h2>Known limits</h2>
          <ul className="flex flex-col gap-3 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                {narrow ? "The band is too narrow." : "The band is checked on few years."}
              </span>{" "}
              The observed total falls inside it in {coverageList}; a 5-95% band should contain about 90% of them.
            </li>
            <li>
              <span className="font-medium text-foreground">Before July 2002 the model sees Terra only.</span> Aqua
              data starts in July 2002, so raw MODIS counts for 2001 and early 2002 are lower partly for that reason.
              Until 8 July 2002 the back-cast uses a separate model fitted on Terra alone; from 9 July 2002 (the first
              full week with Aqua) it uses Terra and Aqua.
            </li>
            <li>
              <span className="font-medium text-foreground">
                The Terra-only years are the least certain, most of all in north-west India.
              </span>{" "}
              Fitting both models on {VIIRS_FROM}-{HOLD_FROM - 1} and predicting 2003-{VIIRS_FROM - 1}, where they can
              be compared, the Terra-only
              model&apos;s annual totals are 7% lower than the Terra and Aqua model&apos;s in Portugal, and in the other
              regions we model 11% lower in Ghana and 32% higher in north-west India. If the same offset holds
              earlier, north-west India&apos;s 2001 and early-2002 values are too high and should not be compared
              directly with later years, while Portugal&apos;s and Ghana&apos;s are somewhat low. The band does not
              include this offset.
            </li>
            <li>
              <span className="font-medium text-foreground">One fit per region.</span> Each region gets its own model
              and its own hold-out score, because fire types and the Terra/Aqua mix differ. The table above gives all
              three.
            </li>
            <li>
              <span className="font-medium text-foreground">
                {lastPartial ? "The last year is partial and comes from another feed." : `${ARCHIVE_END + 1} comes from another feed.`}
              </span>{" "}
              {lastPartial && (
                <>
                  The record ends with {lastYear}, counted so far to {dayLabel(last.data_through)}
                  {last.forward_through
                    ? ` from Suomi NPP and to ${dayLabel(last.forward_through)} with the NOAA-20/21 link (see the hold-out section)`
                    : ""}
                  . It is outside the hold-out and is never compared with full years.{" "}
                </>
              )}
              Up to {ARCHIVE_END} the data are the FIRMS yearly country archives; {ARCHIVE_END + 1} comes from the FIRMS
              area API for each region&apos;s box: standard-processing data where FIRMS has it, near-real-time (NRT)
              data for the last months. NRT files have no fire type field, so the vegetation-fire filter cannot be
              applied to them. Instead a {ARCHIVE_END + 1} detection is kept only if the archive saw fire within the
              same 0.05° cell (about 5.5 km), which removes points across a border and most fixed heat sources.
            </li>
            <li>
              <span className="font-medium text-foreground">MODIS is no longer a fixed witness.</span> The Terra and
              Aqua orbits have been drifting for the last few years. Measured from the FIRMS overpass times, by{" "}
              {ARCHIVE_END + 1} Terra passes about 1.5 hours earlier than in the training years (near 9:10 local time)
              and Aqua about 1.5 hours later (near 15:00), so MODIS sees a different share of each day&apos;s fires.
              The model, fitted when both orbits were stable, then predicts {ARCHIVE_END + 1} about 16% too low in
              Ghana and north-west India. The published record uses observed VIIRS from {VIIRS_FROM} on, so the line
              itself is not affected, but the model should not be read as a forecast from recent MODIS data.
            </li>
          </ul>
        </section>

        <section id="sources">
          <h2>Sources</h2>
          <div className="flex flex-col gap-3">
            <h3 className="font-medium">Data</h3>
            <ul className="flex flex-col gap-2 text-muted-foreground">
              {DATA_SOURCES.map((d) => (
                <li key={d.name}>
                  {d.name},{" "}
                  <a className="break-all underline underline-offset-2 hover:text-foreground" href={d.url}>
                    {d.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="font-medium">Software</h3>
            <dl className="grid gap-x-6 gap-y-2 text-muted-foreground sm:grid-cols-[auto_1fr]">
              {SOFTWARE.map(([name, use]) => (
                <div key={name} className="contents">
                  <dt className="text-foreground">{name}</dt>
                  <dd>{use}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p>
            Use of AI: code, page text and documentation were written with help from Claude (Anthropic). The full list
            of sources with licenses is in the project README.
          </p>
        </section>
      </article>
    </main>
  );
}

type Rec = { id: string; name: string; D: Annual; through: string };

/** Hold-out scores, one column per deep dive (FE-007 table). Whole countries are in the world scoreboard (FE-028). */
function ScoreTable({ records, caption }: { records: Rec[]; caption: string }) {
  const [h0, h1] = holdoutYears(records[0].D);
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">
          {caption}, {h0}-{h1}
        </caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {h0}-{h1}
            </th>
            {records.map((r) => (
              <th key={r.id} scope="col" className="px-3 py-2 font-medium">
                {r.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y text-muted-foreground tabular-nums">
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
              Model, mean annual error
            </th>
            {records.map((r) => (
              <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                {pct(r.D.score.mape_model)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
              Constant factor, mean annual error
            </th>
            {records.map((r) => (
              <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                {pct(r.D.score.mape_ratio)} (×{r.D.score.ratio.toFixed(2)})
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
              Smaller error
            </th>
            {records.map((r) => (
              <td key={r.id} className="px-3 py-2 font-medium whitespace-nowrap text-foreground">
                {r.D.score.mape_model < r.D.score.mape_ratio ? "Model" : "Constant factor"}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
              Years inside the 5-95% band
            </th>
            {records.map((r) => (
              <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                {coverageText(r.D)}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
              Weekly correlation r
            </th>
            {records.map((r) => (
              <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                {r.D.score.weekly_r.toFixed(3)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
