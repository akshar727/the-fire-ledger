import { HOLD_FROM, type Annual } from "./annual.ts";

export type MethodCard = {
  ship: NonNullable<Annual["ship"]>;
  badge: string;
  why: string;
  band?: string;
};

export const BADGE: Readonly<Record<NonNullable<Annual["ship"]>, string>> = {
  model: "Our model",
  caveat: "Our model (band too narrow)",
  ratio: "One constant ratio",
  sparse: "Too little fire to check",
};

const pct = (v: number) => `${v.toFixed(1)}%`;

export function methodCard(D: Pick<Annual, "ship" | "score" | "model_score">): MethodCard | null {
  const ship = D.ship;
  if (!ship || !(ship in BADGE)) return null;
  const s = D.score;
  const yrs = `${HOLD_FROM}-${HOLD_FROM + s.n_hold - 1}`;
  const badge = BADGE[ship];
  if (ship === "sparse")
    return {
      ship,
      badge,
      why: "This country has too few fire detections to test any method, so the years before 2012 are MODIS times one constant ratio and aren't validated.",
    };
  if (ship === "ratio") {
    const m = D.model_score?.mape_model;
    const why =
      m != null && Number.isFinite(m)
        ? `We tried our model for this location: ${pct(m)} was the average error on the hidden years ${yrs} vs ${pct(s.mape_ratio)} for one constant ratio, so the ratio is published.`
        : `One constant ratio is published here: ${pct(s.mape_ratio)} was the average error on the hidden years ${yrs}.`;
    return { ship, badge, why };
  }
  const card: MethodCard = {
    ship,
    badge,
    why: `Our model was closer on the hidden years ${yrs}: ${pct(s.mape_model)} was the average error vs ${pct(s.mape_ratio)} for one constant ratio.`,
  };
  if (ship === "caveat")
    card.band = `But only ${s.coverage} of the ${s.n_hold} hidden years fell inside the 5-95% band, so it's too narrow here.`;
  return card;
}
