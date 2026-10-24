import { Button } from "../ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TourStep {
  title: string;
  body: string;
  /** CSS selector of the region to spotlight; null centres the card over the page. */
  target: string | null;
  /** Optional UTC time to move the replay clock to when the step opens. */
  seekTo?: string;
}

const SPOTLIGHT_PAD = 8;
const CARD_WIDTH = 340;
const CARD_GAP = 14;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function targetRect(selector: string | null): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return {
    top: r.top - SPOTLIGHT_PAD,
    left: r.left - SPOTLIGHT_PAD,
    width: r.width + SPOTLIGHT_PAD * 2,
    height: r.height + SPOTLIGHT_PAD * 2,
  };
}

/** Place the card beside the spotlight, preferring below, then above, then to the left. */
function cardPosition(rect: Rect | null, cardHeight: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampLeft = (x: number) => Math.max(16, Math.min(vw - CARD_WIDTH - 16, x));
  const clampTop = (y: number) => Math.max(16, Math.min(vh - cardHeight - 16, y));
  if (!rect)
    return { top: clampTop((vh - cardHeight) / 2), left: clampLeft((vw - CARD_WIDTH) / 2) };
  // Large regions (the map): put the card inside, near the top-centre.
  if (rect.width > vw * 0.5 && rect.height > vh * 0.5) {
    return {
      top: clampTop(rect.top + 110),
      left: clampLeft(rect.left + (rect.width - CARD_WIDTH) / 2),
    };
  }
  if (rect.top + rect.height + CARD_GAP + cardHeight < vh) {
    return { top: rect.top + rect.height + CARD_GAP, left: clampLeft(rect.left) };
  }
  if (rect.top - CARD_GAP - cardHeight > 0) {
    return { top: rect.top - CARD_GAP - cardHeight, left: clampLeft(rect.left) };
  }
  return { top: clampTop(rect.top), left: clampLeft(rect.left - CARD_WIDTH - CARD_GAP) };
}

export interface TourProps {
  steps: TourStep[];
  onSeek: (ms: number) => void;
  onClose: () => void;
  /** When set, the first step offers the guided story instead of the tour. */
  onStory?: () => void;
}

/** Coach-mark tour: a dimmed page with one spotlighted region and a dialog card per step. */
export default function Tour({ steps, onSeek, onClose, onStory }: TourProps) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(180);
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  useEffect(() => {
    returnFocus.current = document.activeElement;
    return () => {
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    if (step.seekTo) onSeek(Date.parse(step.seekTo));
  }, [step, onSeek]);

  // Track the target's position (layout can shift as the clock moves or panels re-render).
  useLayoutEffect(() => {
    const update = () => setRect(targetRect(step.target));
    update();
    const timer = window.setInterval(update, 400);
    window.addEventListener("resize", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
    };
  }, [step]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
    cardRef.current?.focus();
  }, [index]);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0) return;
      if (next >= steps.length) onClose();
      else setIndex(next);
    },
    [index, steps.length, onClose],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
      } else if (event.key === "Tab") {
        // Keep focus inside the card while the tour is open.
        const focusable = cardRef.current?.querySelectorAll<HTMLElement>("button");
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const lastEl = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          first.focus();
        }
      } else {
        return;
      }
      event.stopImmediatePropagation();
    };
    // Capture phase so the replay's own keyboard shortcuts don't also fire.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose]);

  const pos = cardPosition(rect, cardHeight);
  return (
    <div className="rp-tour">
      {rect ? (
        <div
          className="rp-tour-spot"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          aria-hidden="true"
        />
      ) : (
        <div className="rp-tour-dim" aria-hidden="true" />
      )}
      <div
        ref={cardRef}
        className="rp-tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rp-tour-title"
        aria-describedby="rp-tour-body"
        tabIndex={-1}
        style={{ top: pos.top, left: pos.left, width: CARD_WIDTH }}
      >
        <p className="rp-tour-count">
          Step {index + 1} of {steps.length}
        </p>
        <h2 id="rp-tour-title">{step.title}</h2>
        <p id="rp-tour-body">{step.body}</p>
        {index === 0 && onStory && (
          <Button variant="soft" size="sm" className="rp-story-open--tour" onClick={onStory}>
            <span aria-hidden="true">▶</span> Play the story instead (about 2 min, hands-free)
          </Button>
        )}
        <div className="rp-tour-actions">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Skip tour
          </Button>
          <span>
            {index > 0 && (
              <Button variant="secondary" size="sm" onClick={() => go(-1)}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={() => go(1)}>
              {last ? "Start exploring" : "Next"}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
