/**
 * Forecast fire outlines for the 3D board (DemoDiorama `predictedFire`): predict.ts
 * predictedFireRings at +30 / +60 / +120 min. Recomputed only when the board minute crosses a
 * 5-minute bucket, the solver's fire field changes or the set of reported fires changes, not on
 * every frame. Simulated model output.
 */

import { useMemo } from "react";
import type { PredictedFireRings } from "./DemoBoardOverlay";
import type { Board } from "./model";
import { PREDICT_HORIZONS_MIN, predictedFireRings, reportedSources } from "./predict";

/** Board minutes per recompute bucket. */
const BUCKET_MIN = 5;

export function usePredictedFire(board: Board | null): readonly PredictedFireRings[] | undefined {
  const field = board?.solver.field ?? null;
  const bucket = board ? Math.floor(board.minute / BUCKET_MIN) : -1;
  const reported = board ? reportedSources(board, false).size : 0;
  return useMemo(() => {
    if (!board || !field) return undefined;
    const rings = predictedFireRings(board, PREDICT_HORIZONS_MIN);
    const out = PREDICT_HORIZONS_MIN.map((minutes, i) => ({ minutes, rings: rings[i] ?? [] })).filter((p) => p.rings.length > 0);
    return out.length > 0 ? out : undefined;
    // `board` is mutated in place: the bucket, field and reported-fire count are the recompute keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, field, bucket, reported]);
}
