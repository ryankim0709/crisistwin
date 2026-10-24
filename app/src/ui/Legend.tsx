import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

export type LegendItem = {
  label: ReactNode;
  /** Any CSS colour, ideally a `var(--ct-…)` token. */
  color: string;
  /** Shape carries meaning alongside colour (AGENTS.md: no colour-only legends). */
  shape?: "square" | "line" | "dot" | "dashed";
  /** Custom glyph (e.g. an inline SVG icon) drawn instead of the swatch. */
  glyph?: ReactNode;
};

/** Map/scene legend: swatch + text for each item. */
export function Legend({
  items,
  className,
  label = "Legend",
}: {
  items: readonly LegendItem[];
  className?: string;
  label?: string;
}) {
  return (
    <ul className={cx("ui-legend", className)} aria-label={label}>
      {items.map((item, index) => (
        <li key={index}>
          {item.glyph ? (
            <span aria-hidden="true" className="ui-legend-glyph">
              {item.glyph}
            </span>
          ) : (
            <span
              aria-hidden="true"
              className={cx(
                "ui-legend-swatch",
                item.shape && item.shape !== "square" && `ui-legend-swatch--${item.shape}`,
              )}
              style={{ "--swatch": item.color } as CSSProperties}
            />
          )}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
