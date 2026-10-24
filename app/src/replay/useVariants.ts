import { useCallback, useEffect, useRef, useState } from "react";
import type { VariantLoad } from "./CompareTab";
import { fetchJson, parseVariant, parseVariantIndex, type Variant, type VariantIndex } from "./compare";
import type { ReplayModel } from "./types";

export interface VariantsState {
  /** null while loading, when the route has no variants, or when none exist. */
  index: VariantIndex | null;
  load: VariantLoad;
  showVariant: boolean;
  setShowVariant: (show: boolean) => void;
  select: (id: string | null) => void;
  /** The variant currently drawn on the map and in the panels, if any. */
  shown: Variant | null;
}

function variantUrl(indexUrl: string, file: string): string {
  return indexUrl.slice(0, indexUrl.lastIndexOf("/") + 1) + file;
}

/** Loads the what-if index once and variants on demand; newer selections cancel older ones. */
export function useVariants(baseline: ReplayModel, indexUrl: string | null): VariantsState {
  const [index, setIndex] = useState<VariantIndex | null>(null);
  const [load, setLoad] = useState<VariantLoad>({ status: "idle" });
  const [showVariant, setShowVariant] = useState(true);
  const cache = useRef(new Map<string, Variant>());
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!indexUrl) return;
    const controller = new AbortController();
    fetchJson(indexUrl, controller.signal)
      .then((data) => {
        if (data === null) return;
        const parsed = parseVariantIndex(data);
        if (parsed.variants.length > 0) setIndex(parsed);
      })
      .catch((error: unknown) => {
        // Variants are optional: a bad or missing index hides the control, but is logged.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("What-if variants unavailable", error);
        }
      });
    return () => controller.abort();
  }, [indexUrl]);

  useEffect(() => () => inflight.current?.abort(), []);

  const select = useCallback(
    (id: string | null) => {
      inflight.current?.abort();
      inflight.current = null;
      if (id === null || !index || !indexUrl) {
        setLoad({ status: "idle" });
        return;
      }
      const cached = cache.current.get(id);
      if (cached) {
        setLoad({ status: "ready", variant: cached });
        setShowVariant(true);
        return;
      }
      const summary = index.variants.find((v) => v.id === id);
      if (!summary) return;
      const controller = new AbortController();
      inflight.current = controller;
      setLoad({ status: "loading", id });
      fetchJson(variantUrl(indexUrl, summary.file), controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          if (data === null) throw new Error("variant file not found");
          const variant = parseVariant(data, baseline);
          cache.current.set(id, variant);
          setLoad({ status: "ready", variant });
          setShowVariant(true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setLoad({ status: "error", id, message: error instanceof Error ? error.message : "unknown error" });
        });
    },
    [baseline, index, indexUrl],
  );

  const shown = load.status === "ready" && showVariant ? load.variant : null;
  return { index, load, showVariant, setShowVariant, select, shown };
}
