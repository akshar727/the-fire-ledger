import type { Metadata } from "next";
import { GlobeExplorer } from "@/components/globe/GlobeExplorer";
import { readPlaces } from "@/lib/globe-server";
import { logBins, per1000 } from "@/lib/globe";

export const metadata: Metadata = {
  title: "Globe",
  description: "Every place with a harmonized MODIS + VIIRS fire ledger, on a 3D globe, coloured by detections per 1,000 km².",
};

const { years, places, unmatched } = readPlaces();
const hasCountries = places.some((p) => p.tier === "country");
const edges = logBins(places.flatMap((p) => p.harmonized.map((v) => per1000(v, p.km2))));

export default function GlobePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-6 pb-20 sm:px-6">
      <header className="flex max-w-[68ch] flex-col gap-1.5">
        <span className="kicker">One Fire Ledger · world</span>
        <h1 className="text-3xl leading-tight font-bold tracking-tight md:text-4xl">The world&apos;s fire ledger</h1>
        <p className="leading-relaxed text-muted-foreground">
          Every place with a harmonized ledger, {years[0]} to {years.at(-1)}, coloured by fire detections per 1,000
          km² on the VIIRS scale. Move the year, or switch to the trend to see where fire is rising or falling.
          {!hasCountries &&
            " Countries fill in as the world run publishes them; until then the three deep dives carry the colour."}
        </p>
      </header>
      <GlobeExplorer years={years} places={places} edges={edges} unmatched={unmatched} />
    </main>
  );
}
