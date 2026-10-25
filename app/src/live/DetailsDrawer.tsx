import { useEffect, useRef, type ReactNode } from "react";
import { IconButton, Panel } from "../ui";

/**
 * A slide-over over the map's right edge for the panels that left the sidebar. Non-modal (the
 * map and sidebar stay usable); Escape or the close button shuts it and focus returns to where
 * it was when the drawer opened (the Details button).
 */
export default function DetailsDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
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
      className="lc-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="lc-drawer-title"
    >
      <header className="lc-drawer-head">
        <h2 id="lc-drawer-title">Details</h2>
        <IconButton label="Close details" size="sm" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div className="lc-drawer-body">{children}</div>
    </Panel>
  );
}
