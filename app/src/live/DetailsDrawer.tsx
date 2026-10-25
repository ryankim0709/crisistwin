import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton, Panel } from "../ui";

/**
 * A slide-over over one edge of the map: "Details" (the panels that left the sidebar, right
 * edge) and the full audit log (left edge, beside the activity feed). Non-modal (the map and
 * columns stay usable); Escape or the close button shuts it and focus returns to where it was
 * when the drawer opened (its opening button).
 */
export default function DetailsDrawer({
  open,
  onClose,
  children,
  title = "Details",
  side = "right",
  fill = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  side?: "left" | "right";
  /** The child fills the body and scrolls itself (the audit log) instead of the body scrolling. */
  fill?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLButtonElement>(".lc-drawer-head button")?.focus();
    // Capture phase, so Escape closes the drawer before the triage keys clear the selection.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <Panel
      ref={panelRef}
      glass
      compact
      className={`lc-drawer lc-drawer--${side}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <header className="lc-drawer-head">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={`Close ${title.toLowerCase()}`} size="sm" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div className={`lc-drawer-body${fill ? " lc-drawer-body--fill" : ""}`}>{children}</div>
    </Panel>
  );
}
