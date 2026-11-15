import type { Metadata } from "next";
import { loadAnnual } from "@/lib/data";

export const metadata: Metadata = { title: "Method" };

const SECTIONS = [
  { id: "problem", title: "The problem" },
  { id: "harmonization", title: "How the conversion works" },
  { id: "holdout", title: "What the hold-out shows" },
  { id: "caveats", title: "Known limits" },
  { id: "sources", title: "Sources" },
] as const;

const DATA_SOURCES = [
  {
    name: "NASA FIRMS, MODIS Collection 6.1 active fire (Terra and Aqua), country archive",
    url: "https://firms.modaps.eosdis.nasa.gov/country/",
  },
  {
    name: "NASA FIRMS, VIIRS 375 m active fire (Suomi NPP), country archive",
    url: "https://firms.modaps.eosdis.nasa.gov/country/",
  },
];

const SOFTWARE = [
  ["numpy, pandas, statsmodels, patsy, scipy", "Gridding, model fitting and bootstrap (Python)"],
  ["Next.js, React", "This website"],
  ["Tailwind CSS, shadcn/ui, Radix UI", "Styling and interface components"],
  ["Phosphor Icons, Geist", "Icons and typeface"],
] as const;

export default function MethodPage() {
  const { score } = loadAnnual("portugal");
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

      <article className="flex max-w-[68ch] flex-col gap-12 leading-relaxed [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:text-muted-foreground [&_section]:flex [&_section]:scroll-mt-24 [&_section]:flex-col [&_section]:gap-4">
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
            NPP since 2012). VIIRS pixels are 375 m against MODIS&apos;s 1 km, so VIIRS sees more and smaller fires.
            Joining the two records at 2012 creates a jump in detections that is about the sensor, not about fire.
          </p>
        </section>

        <section id="harmonization">
          <h2>How the conversion works</h2>
          <p>
            We keep presumed vegetation fires (FIRMS type 0) inside mainland Portugal and count detections per 0.25°
            grid cell, per week, separately for day and night passes. Every cell that ever burned gets a row for every
            week, so weeks where MODIS saw nothing are modelled too.
          </p>
          <p>
            For 2012-2019, when both sensors flew, a Poisson regression learns the VIIRS count in each cell-week from
            what MODIS saw there: Terra and Aqua counts, their mean fire radiative power, total MODIS activity across
            the region that week, and the month, latitude band and day or night. Applied to 2001-2011, it gives a
            VIIRS-equivalent count for years before VIIRS existed. Summed over the year, that is the harmonized line.
          </p>
          <p>
            The band shows the 5th to 95th percentile of 200 simulated yearly totals. Each simulation refits the model
            on training years drawn with replacement, scales each year up or down by one shared random factor, then
            adds count noise from a negative binomial distribution. The yearly factor is sized from how far off the
            model was for each training year when that year was left out of the fit (about{" "}
            {(score.sigma_year * 100).toFixed(0)}% here), so the band covers model uncertainty, whole-year departures
            and count noise.
          </p>
        </section>

        <section id="holdout">
          <h2>What the hold-out shows</h2>
          <p>
            We never fit on 2020-2025. Predicting those years from MODIS alone, the model&apos;s mean annual error is{" "}
            {score.mape_model.toFixed(1)}%, against {score.mape_ratio.toFixed(1)}% for a single constant factor of{" "}
            {score.ratio.toFixed(2)}. Week by week, predicted and observed totals correlate at r ={" "}
            {score.weekly_r.toFixed(3)}.
          </p>
          <p>
            This is a forward test: it shows the model carries over to later years. It cannot directly prove accuracy
            for 2001-2011, because no VIIRS data exists then to check against.
          </p>
        </section>

        <section id="caveats">
          <h2>Known limits</h2>
          <ul className="flex flex-col gap-3 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                {score.coverage < score.n_hold - 1 ? "The band is too narrow." : "The band is checked on few years."}
              </span>{" "}
              The observed total falls inside it in {score.coverage} of {score.n_hold} hold-out years; a 5-95% band
              should contain about 90% of them.
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
              Fitting both models on 2012-2019 and predicting 2003-2011, where they can be compared, the Terra-only
              model&apos;s annual totals are 7% lower than the Terra and Aqua model&apos;s in Portugal, and in the other
              regions we model 11% lower in Ghana and 32% higher in north-west India. If the same offset holds
              earlier, north-west India&apos;s 2001 and early-2002 values are too high and should not be compared
              directly with later years, while Portugal&apos;s and Ghana&apos;s are somewhat low. The band does not
              include this offset.
            </li>
            <li>
              <span className="font-medium text-foreground">One fit per region.</span> Each region gets its own model
              and its own hold-out score, because fire types and the Terra/Aqua mix differ. This page shows mainland
              Portugal.
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
