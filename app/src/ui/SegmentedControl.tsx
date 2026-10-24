import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  title?: string;
  /** Optional leading glyph; the text label stays visible. */
  icon?: ReactNode;
  /** Unavailable right now; skipped by arrow keys. Explain why with `title` or nearby text. */
  disabled?: boolean;
};

/**
 * A single-choice toggle group (view modes, units, speeds). Renders a radiogroup with
 * roving focus: arrow keys move and select, matching native radio behaviour.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  /** Accessible name for the group. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    let next = index;
    for (let tries = 0; tries < options.length; tries++) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    if (next === index || options[next].disabled) return;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("ui-segmented", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            title={option.title}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.icon && <span aria-hidden="true">{option.icon}</span>}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
