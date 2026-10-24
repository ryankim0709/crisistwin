import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";

/** Standard scrolling page inside the sidebar shell: title, description, optional action. */
export function Page({
  title,
  description,
  eyebrow,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="ui-page" id="main-content" tabIndex={-1}>
      <header className="ui-page-header">
        <div>
          {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </main>
  );
}

/**
 * A titled content surface. `glass` is the frosted floating variant used over maps and
 * 3D scenes; `compact` tightens padding for side panels.
 */
export function Panel({
  title,
  eyebrow,
  aside,
  glass,
  compact,
  className,
  children,
  ...rest
}: {
  title?: ReactNode;
  eyebrow?: string;
  aside?: ReactNode;
  glass?: boolean;
  compact?: boolean;
  /** React 19 passes `ref` as a prop, so positioned floating panels can measure themselves. */
  ref?: Ref<HTMLElement>;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section
      className={cx(
        "ui-panel",
        glass && "ui-panel--glass",
        compact && "ui-panel--compact",
        className,
      )}
      {...rest}
    >
      {(title || eyebrow || aside) && (
        <div className="ui-panel-heading">
          <div>
            {eyebrow && <p className="ui-eyebrow">{eyebrow}</p>}
            {title && <h2>{title}</h2>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** A bordered tile for grids of items (incidents, scenarios, templates). */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <article className={cx("ui-card", className)} {...rest}>
      {children}
    </article>
  );
}

/** Small uppercase label above a heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="ui-eyebrow">{children}</p>;
}
