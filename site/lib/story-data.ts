// Build-time data for the landing story (FE-018, route `/`). Server components only: reads two published files with a
// synchronous fs read while `/` is prerendered, so the page ships as static HTML and the browser downloads neither the
// 1 MB points file nor series.json. `/` MUST stay static: on a dynamic or ISR route these reads would run in a
// serverless function, where public/ is not traced (unlike lib/data.ts, which imports JSON). A missing file fails the
// build on purpose, since the story has no fallback. Everything is computed by the pure helpers in lib/story.ts and lib/series.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import regionIndex from "@/public/data/index.json";
import { eraMeans, holdoutYears, lastCompleteYear } from "@/lib/annual";
import { loadAnnual, REGION_LIST, REGIONS, type RegionId } from "@/lib/data";
import { buildGrid, parseSeries } from "@/lib/series";
import { closestPair, extent, inBox, parsePoints, SCENE_BBOX, STORY_FIRE, storyLines } from "@/lib/story";

/** The region chapters 4-6 follow: Ghana has the clearest 2012 jump (the demo path's step 2 uses it too). */
export const STORY_REGION: RegionId = "ghana";

const file = (...p: string[]) => path.join(process.cwd(), "public", "data", ...p);

export function loadStory() {
  const counts = REGION_LIST.map((r) => {
    const sensors = regionIndex.regions.find((x) => x.id === r.id)!.sensors;
    return { id: r.id, name: REGIONS[r.id], rows: r.point_rows, since: sensors.terra.first_date, through: r.data_through };
  });

  const points = parsePoints(readFileSync(file(STORY_FIRE.region, "points", `${STORY_FIRE.date.slice(0, 4)}.csv`), "utf8"));
  const pair = closestPair(points, STORY_FIRE.date, STORY_FIRE.bbox);
  if (!pair) throw new Error(`no MODIS/VIIRS pass pair for ${STORY_FIRE.date} in the story box`);
  const frame = extent([...pair.modis.points, ...pair.viirs.points], 1500);

  const annual = loadAnnual(STORY_REGION);
  const lines = storyLines(annual);
  const grid = buildGrid(parseSeries(JSON.parse(readFileSync(file(STORY_REGION, "series.json"), "utf8"))));

  return {
    counts,
    fire: { ...pair, frame },
    region: { id: STORY_REGION, name: REGIONS[STORY_REGION], jump: eraMeans(annual).jump, lastComplete: lastCompleteYear(annual) },
    lines,
    score: annual.score,
    holdout: holdoutYears(annual),
    grid,
    // FE-019: what the scroll scene behind the page is made of (scripts/landing_scene draws the same points)
    scene: { year: Number(STORY_FIRE.date.slice(0, 4)), detections: points.filter((d) => inBox(d, SCENE_BBOX)).length },
  };
}

export type Story = ReturnType<typeof loadStory>;
