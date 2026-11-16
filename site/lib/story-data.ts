import { readFileSync } from "node:fs";
import path from "node:path";
import regionIndex from "@/public/data/index.json";
import { eraMeans, holdoutYears, lastCompleteYear } from "@/lib/annual";
import { REGION_LIST, REGIONS, type RegionId } from "@/lib/data";
import { readAnnual as loadAnnual } from "@/lib/data-server";
import { buildGrid, parseSeries } from "@/lib/series";
import { closestPair, extent, inBox, parsePoints, SCENE_BBOX, STORY_FIRE, storyLines } from "@/lib/story";

export const STORY_REGION: RegionId = "ghana";

const file = (...p: string[]) => path.join(process.cwd(), "public", "data", ...p);

export function loadStory() {
  const counts = REGION_LIST.filter((r) => r.tier === "region").map((r) => {
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
    scene: { year: Number(STORY_FIRE.date.slice(0, 4)), detections: points.filter((d) => inBox(d, SCENE_BBOX)).length },
  };
}

export type Story = ReturnType<typeof loadStory>;
