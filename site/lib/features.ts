import regionIndex from "../public/data/index.json" with { type: "json" };

type Entry = { id: string; tier?: string; ship?: string; first_year?: number };

export type FeatureTile = {
  tag: string;
  title: string;
  text: string;
  href: string;
};

export function worldCounts(index: { regions: Entry[] }) {
  const countries = index.regions.filter((r) => r.tier === "country" && typeof r.first_year === "number");
  const model = countries.filter((r) => r.ship === "model" || r.ship === "caveat").length;
  const deepDives = index.regions.filter((r) => r.tier !== "country" && typeof r.first_year === "number").length;
  return { countries: countries.length, model, deepDives };
}

export function featureTiles(index: { regions: Entry[] }, spaceRegion: string): FeatureTile[] {
  const { countries, model } = worldCounts(index);
  const tiles: FeatureTile[] = [];
  if (countries > 0) {
    tiles.push({
      tag: "Globe",
      title: `Explore ${countries} countries on a 3D globe`,
      text: "Spin the world, pick a year, and see where fire rose or fell since 2001.",
      href: "/globe",
    });
    tiles.push({
      tag: "Scoreboard",
      title: `Our model against one simple ratio: it won in ${model} of ${countries} countries`,
      text: "Every country tested on years it never saw. Where the ratio did better, we publish the ratio.",
      href: "/method#scoreboard",
    });
  }
  tiles.push(
    {
      tag: "Proof",
      title: "Checked on years the model never saw",
      text: "Trained on 2012 to 2019, scored on 2020 to 2025 against what VIIRS really counted.",
      href: "/method#holdout",
    },
    {
      tag: "Calendar",
      title: "Every month since 2001 on one scale",
      text: "One square per month: spot the bad seasons and the quiet ones at a glance.",
      href: "/calendar",
    },
    {
      tag: "From space",
      title: "See a month's fires on NASA satellite imagery",
      text: "Below the burn calendar, pick any month and its detections appear on the picture.",
      href: `/calendar?region=${spaceRegion}`,
    },
    {
      tag: "Drift",
      title: "Why the satellites drift, and why it matters",
      text: "Terra and Aqua now pass at different hours, so MODIS sees a different share of each day's fire.",
      href: "/method#drift",
    },
  );
  return tiles;
}

export const FEATURE_TILES: readonly FeatureTile[] = featureTiles(
  regionIndex as { regions: Entry[] },
  (regionIndex as { regions: Entry[] }).regions.find((r) => r.tier !== "country")?.id ?? "portugal",
);
