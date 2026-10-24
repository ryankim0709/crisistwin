import { VERDICT } from "./format";
import type { GuidanceLevel } from "./types";

/**
 * The Slab on the web (design spec "Mini plate"): the verdict phones show, set solid in the
 * level colour, with the way out underneath. The verdict text carries the meaning; colour repeats it.
 * `none` has no slab on the phone, so it renders as a quiet outline.
 */
export default function Plate({
  level,
  line,
  verdict,
  muted,
}: {
  level: GuidanceLevel;
  /** Second line: "Via X to Y, 12 min", "No open route", or null. */
  line?: string | null;
  /** Overrides the level's verdict (e.g. a zone name on the evacuation picture). */
  verdict?: string;
  /** The "before" side of a change: drawn at lower contrast. */
  muted?: boolean;
}) {
  return (
    <span className={`lc-plate lc-plate--${level}${muted ? " lc-plate--muted" : ""}`}>
      <span className="lc-plate-verdict">{verdict ?? VERDICT[level]}</span>
      {line ? <span className="lc-plate-line">{line}</span> : null}
    </span>
  );
}
