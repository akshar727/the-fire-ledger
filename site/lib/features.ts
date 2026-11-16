import regionIndex from "../public/data/index.json" with { type: "json" };

type Entry = { id: string; tier?: string; ship?: string; first_year?: number };

export type FeatureTile = {
  tag: string;
  title: string;
  text: string;
  href: string;
};

export function worldCounts(index: { regions: Entry[] }) {
  const countries = index.regions.filter(
    (r) => r.tier === "country" && typeof r.first_year === "number",
  );
  const model = countries.filter(
    (r) => r.ship === "model" || r.ship === "caveat",
  ).length;
  const deepDives = index.regions.filter(
    (r) => r.tier !== "country" && typeof r.first_year === "number",
  ).length;
  return { countries: countries.length, model, deepDives };
}

export function featureTiles(
  index: { regions: Entry[] },
  spaceRegion: string,
): FeatureTile[] {
  const { countries, model } = worldCounts(index);
  const tiles: FeatureTile[] = [];
  if (countries > 0) {
    tiles.push({
      tag: "Globe",
      title: `Explore ${countries} countries on the globe`,
      text: "Pick any country and any year and see where fire rose or fell since 2001.",
      href: "/globe",
    });
    tiles.push({
      tag: "Scoreboard",
      title: `Our model vs a simple ratio: it performed better in ${model} of ${countries} countries`,
      text: "Our model and a ratio was tested on every country in unseen data. We showed whichever is better.",
      href: "/method#scoreboard",
    });
  }
  tiles.push(
    {
      tag: "Proof",
      title: "Checked on years the model never saw",
      text: "Trained on 2012-2019 and scored on 2020-2025 against what VIIRS really measured.",
      href: "/method#holdout",
    },
    {
      tag: "Calendar",
      title: "Every month since 2001 on one grid",
      text: "One square per month: spot the bad and tranquil seasons at a glance.",
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
      title: "Satellite drifts, and this is why it matters",
      text: "Terra and Aqua now pass at different hours, so MODIS can see different states of a day's fire.",
      href: "/method#drift",
    },
  );
  return tiles;
}

export const FEATURE_TILES: readonly FeatureTile[] = featureTiles(
  regionIndex as { regions: Entry[] },
  (regionIndex as { regions: Entry[] }).regions.find(
    (r) => r.tier !== "country",
  )?.id ?? "portugal",
);
