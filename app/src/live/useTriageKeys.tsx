import { useEffect, useRef } from "react";
import type { QueueItem } from "./queue";
import { triageItem, type TriageKind } from "./triageActions";
import type { RunAction } from "./SelectedItem";

const TRIAGE: Record<string, TriageKind> = { c: "confirm", d: "dismiss", r: "resolve" };

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** j/k move through the shown queue; c/d/r triage the selection; Escape clears it. */
export function useTriageKeys({
  shown,
  selected,
  busy,
  run,
  onSelect,
  onError,
}: {
  shown: QueueItem[];
  selected: QueueItem | null;
  busy: string | null;
  run: RunAction;
  onSelect: (id: string | null) => void;
  onError: (message: string) => void;
}) {
  const state = useRef({ shown, selected, busy, run, onSelect, onError });
  useEffect(() => {
    state.current = { shown, selected, busy, run, onSelect, onError };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(e.target)) return;
      const { shown, selected, busy, run, onSelect, onError } = state.current;
      const k = e.key;
      const inQueue = !!(e.target as HTMLElement | null)?.closest?.(".lc-queue");
      // The queue handles its own arrows when focused.
      if (k === "j" || k === "k") {
        e.preventDefault();
        if (!shown.length) return;
        const i = shown.findIndex((x) => x.id === selected?.id);
        const step = k === "j" ? 1 : -1;
        const next = shown[i < 0 ? (step > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, i + step))];
        onSelect(next.id);
        document.getElementById(`lc-q-${next.id}`)?.scrollIntoView({ block: "nearest" });
      } else if ((k === "ArrowDown" || k === "ArrowUp") && inQueue) {
        // handled by the row
      } else if (k === "Escape") {
        if (selected) onSelect(null);
      } else if (TRIAGE[k] && selected && busy === null) {
        const p = triageItem(run, selected, TRIAGE[k]);
        if (p) {
          e.preventDefault();
          void p.then((message) => {
            if (message) onError(message);
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
