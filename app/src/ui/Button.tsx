import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type StyleProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
  /** Leading icon (an inline SVG or glyph); hidden from assistive technology. */
  icon?: ReactNode;
};

export function buttonClass({
  variant = "primary",
  size = "md",
  block,
  iconOnly,
}: StyleProps & { iconOnly?: boolean }) {
  return cx(
    "ui-button",
    variant !== "primary" && `ui-button--${variant}`,
    size === "sm" && "ui-button--sm",
    block && "ui-button--block",
    iconOnly && "ui-button--icon",
  );
}

/** The one button. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({
  variant,
  size,
  block,
  icon,
  className,
  children,
  type = "button",
  ...rest
}: StyleProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cx(buttonClass({ variant, size, block }), className)} {...rest}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}

/** Icon-only button. `label` is required: it becomes the accessible name and tooltip. */
export function IconButton({
  label,
  variant = "ghost",
  size,
  className,
  children,
  type = "button",
  ...rest
}: {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(buttonClass({ variant, size, iconOnly: true }), className)}
      {...rest}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

/** A link styled as a button, for navigation (use `Button` for actions). */
export function LinkButton({
  variant,
  size,
  block,
  icon,
  className,
  children,
  ...rest
}: StyleProps & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cx(buttonClass({ variant, size, block }), className)} {...rest}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
    </a>
  );
}
