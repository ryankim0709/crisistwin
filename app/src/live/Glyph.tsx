import type { ReportKind } from "./types";

/** 16 px line glyphs for report kinds; decorative (the row title names the kind). */
const PATHS: Record<ReportKind, string> = {
  road_blocked: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3.5 8h9",
  road_passable: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM5 8.2l2 2 4-4.4",
  heavy_traffic: "M3 10.5h10M4 10.5l1.2-4h5.6l1.2 4M5 12.5v.5M11 12.5v.5M2 4h3M11 4h3",
  fire_seen: "M8 14.5c2.8 0 4.5-1.9 4.5-4.4 0-2.9-2.6-4.4-3.4-8.1C7.4 3.8 7 5.2 7.3 6.8 6.2 6.2 5.6 5 5.6 4 4.3 5.5 3.5 7.6 3.5 10.1c0 2.5 1.7 4.4 4.5 4.4Z",
  heavy_smoke: "M2 6c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 2.5-1 3 0M2 10c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 2.5-1 3 0",
  hazard_down: "M9 1.5 4 9h4l-1 5.5L12 7H8l1-5.5Z",
  shelter_full: "M2.5 7.5 8 2.5l5.5 5M4 6.5v7h8v-7M6.5 13.5V10h3v3.5",
  help_needed: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 4.5v4.5M8 11.2v.3",
};

export default function KindGlyph({ kind }: { kind: ReportKind }) {
  return (
    <svg
      className={`lc-glyph lc-glyph--${kind}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[kind] ?? PATHS.hazard_down} />
    </svg>
  );
}
