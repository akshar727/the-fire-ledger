import type { Metadata } from "next";
import { dayLabel, HOLD_FROM, holdoutYears, isPartial, VIIRS_FROM, type Annual } from "@/lib/annual";
import { loadAnnual, recordSpan, REGION_LIST, REGIONS } from "@/lib/data";

export const metadata: Metadata = { title: "Method" };

const SECTIONS = [
  { id: "problem", title: "The problem" },
  { id: "harmonization", title: "How the conversion works" },
  { id: "holdout", title: "What the hold-out shows" },
  { id: "caveats", title: "Known limits" },
  { id: "sources", title: "Sources" },
] as const;

const ARCHIVE_URL = "https://firms.modaps.eosdis.nasa.gov/country/";
const AREA_API_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/";

// Every region, in index.json order, with its annual record (scores, years) and display name.
const RECORDS = REGION_LIST.map((r) => ({ id: r.id, name: REGIONS[r.id], D: loadAnnual(r.id) }));
const SPAN = recordSpan();
// End of the downloaded record (index.json archive_through, the same for every region), e.g. 2026-11-02.
const THROUGH = REGION_LIST.map((r) => r.data_through).sort().at(-1)!;
const ARCHIVE_END = Number(THROUGH.slice(0, 4)) - 1; // yearly archives run to the year before the area API takes over

const pct = (v: number) => `${v.toFixed(1)}%`;
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
];

const SOFTWARE = [
  ["numpy, pandas, statsmodels, patsy, scipy", "Gridding, model fitting and bootstrap (Python)"],
  ["Next.js, React", "This website"],
  ["Tailwind CSS, shadcn/ui, Radix UI", "Styling and interface components"],
  ["Phosphor Icons, Geist", "Icons and typeface"],
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
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-tighter md:text-5xl">Method</h1>
          <p className="text-lg">
            How we turn two satellite fire records into one, and how far the result can be trusted.
          </p>
        </header>

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
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">Hold-out scores per region, {h0}-{h1}</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {h0}-{h1}
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
                    Model, mean annual error
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                      {pct(r.D.score.mape_model)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Constant factor, mean annual error
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                      {pct(r.D.score.mape_ratio)} (×{r.D.score.ratio.toFixed(2)})
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Smaller error
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 font-medium whitespace-nowrap text-foreground">
                      {r.D.score.mape_model < r.D.score.mape_ratio ? "Model" : "Constant factor"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Years inside the 5-95% band
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                      {coverageText(r.D)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-foreground">
                    Weekly correlation r
                  </th>
                  {RECORDS.map((r) => (
                    <td key={r.id} className="px-3 py-2 whitespace-nowrap">
                      {r.D.score.weekly_r.toFixed(3)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
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
          <p>
            This is a forward test: it shows whether the model carries over to later years. It cannot directly prove
            accuracy for {SPAN.first}-{VIIRS_FROM - 1}, because no VIIRS data exists then to check against.
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
                  The record ends with {lastYear}, counted so far to {dayLabel(last.data_through)}. It is outside the
                  hold-out and is never compared with full years.{" "}
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
