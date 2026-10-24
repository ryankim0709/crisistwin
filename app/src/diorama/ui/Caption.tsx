import { useState } from "react";
import { Eyebrow, Panel } from "../../ui";

type CaptionProps = { phaseLabel: string; caption: string; reducedMotion: boolean };

type Line = { key: number; text: string };

/**
 * Current event caption. A changed caption fades in over the previous one (no motion when
 * reduced motion is requested). The screen-reader announcement lives in a separate polite
 * region that only changes with the caption text.
 */
export default function Caption({ phaseLabel, caption, reducedMotion }: CaptionProps) {
  const [current, setCurrent] = useState<Line>({ key: 0, text: caption });
  const [previous, setPrevious] = useState<Line | null>(null);

  // Adjust state while rendering when the caption prop changes (no effect round trip).
  if (current.text !== caption) {
    setPrevious(reducedMotion ? null : current);
    setCurrent({ key: current.key + 1, text: caption });
  }

  return (
    <Panel glass compact className="dio-caption">
      <Eyebrow>{phaseLabel}</Eyebrow>
      <div className="dio-caption-lines" aria-hidden="true">
        {previous && !reducedMotion && (
          <p
            key={previous.key}
            className="dio-caption-text is-leaving"
            onAnimationEnd={() => setPrevious(null)}
          >
            {previous.text}
          </p>
        )}
        <p
          key={current.key}
          className={`dio-caption-text${current.key > 0 && !reducedMotion ? " is-entering" : ""}`}
        >
          {current.text}
        </p>
      </div>
      <p className="dio-visually-hidden" aria-live="polite" aria-atomic="true">
        {caption}
      </p>
    </Panel>
  );
}
