/**
 * The 3D diorama's arrival field (dioramaField.ts): the board's current fire-solver field on its
 * landscape grid. It changes only when a new solve is installed; between solves the scene's time
 * (the board minute) reveals the field. A new board (restart, incident switch) or grid starts over.
 */

import { useMemo } from "react";
import type { LandscapeGrid } from "../fire/landscape";
import { arrivalFieldOf, type ArrivalField } from "./dioramaField";
import type { Board } from "./model";

export interface ArrivalFieldState {
  board: Board;
  field: ArrivalField;
  /** Increments whenever the field changed (a new solve). */
  stamp: number;
}

const stamps = new WeakMap<object, number>();
let lastStamp = 0;
function stampOf(field: object): number {
  let stamp = stamps.get(field);
  if (stamp === undefined) {
    stamp = ++lastStamp;
    stamps.set(field, stamp);
  }
  return stamp;
}

export function useArrivalField(board: Board | null, version: number, grid: LandscapeGrid | null): ArrivalFieldState | null {
  const solved = board?.solver.field ?? null;
  void version; // The board is mutated in place; the solver field's identity marks a new solve.
  return useMemo(() => {
    if (!board || !grid || !solved || board.env.landscape !== grid) return null;
    const field = arrivalFieldOf(board);
    return field ? { board, field, stamp: stampOf(solved) } : null;
  }, [board, grid, solved]);
}
