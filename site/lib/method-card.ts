// FE-032: "How this record was made" card on a country's ledger page: which method was published (annual.json `ship`)
// and why, with both hold-out errors. Pure, so `node --test` can check every label. Deep dives have no `ship`: no card.
import { HOLD_FROM, type Annual } from "./annual.ts";

export type MethodCard = {
  ship: NonNullable<Annual["ship"]>;
  badge: string; // the published method in plain words
  why: string; // one sentence, with both numbers from the hidden years
  band?: string; // `caveat` only: why the band is flagged
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
      why: "This country has too few fire detections to test any method, so the years before 2012 are MODIS times one constant ratio and are not validated.",
    };
  if (ship === "ratio") {
    const m = D.model_score?.mape_model;
    // ML-027: a ratio country's `score` is the single ratio's own (mape_model = mape_ratio); the losing model is in model_score
    const why =
      m != null && Number.isFinite(m)
        ? `We tried our model here: ${pct(m)} average error on the hidden years ${yrs} vs ${pct(s.mape_ratio)} for one constant ratio, so the ratio is published.`
        : `One constant ratio is published here: ${pct(s.mape_ratio)} average error on the hidden years ${yrs}.`;
    return { ship, badge, why };
  }
  const card: MethodCard = {
    ship,
    badge,
    why: `Our model was closer on the hidden years ${yrs}: ${pct(s.mape_model)} average error vs ${pct(s.mape_ratio)} for one constant ratio.`,
  };
  if (ship === "caveat")
    card.band = `But only ${s.coverage} of the ${s.n_hold} hidden years fell inside its 5-95% band, so the band is too narrow here.`;
  return card;
}
