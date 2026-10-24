import { useEffect, useRef, type RefObject } from "react";
import type { PickTarget } from "../types";

/** Gap between the picked object's projected point and the label, in CSS px. */
const ANCHOR_GAP_PX = 14;
/** Minimum distance kept between the label and the stage edges, in CSS px. */
const EDGE_PX = 12;

type PickLabelProps = {
  target: PickTarget;
  title: string;
  lines: string[];
  /** Projects the target into CSS px within the stage, or null when it is off screen. */
  project: (target: PickTarget) => { x: number; y: number } | null;
  stageRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

/**
 * Small contextual label anchored to a picked object. Its position follows the camera on
 * every animation frame by writing a transform directly, without re-rendering React.
 */
export default function PickLabel({ target, title, lines, project, stageRef, onClose }: PickLabelProps) {
  const labelRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const label = labelRef.current;
      const stage = stageRef.current;
      if (label && stage) {
        const point = projectRef.current(target);
        if (!point) {
          label.style.visibility = "hidden";
        } else {
          const w = label.offsetWidth;
          const h = label.offsetHeight;
          const maxX = stage.clientWidth - w - EDGE_PX;
          const maxY = stage.clientHeight - h - EDGE_PX;
          const x = Math.max(EDGE_PX, Math.min(maxX, point.x - w / 2));
          let y = point.y - h - ANCHOR_GAP_PX;
          if (y < EDGE_PX) y = point.y + ANCHOR_GAP_PX;
          y = Math.max(EDGE_PX, Math.min(maxY, y));
          label.style.visibility = "visible";
          label.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [target, stageRef]);

  return (
    <div ref={labelRef} className="dio-pick dio-panel" role="dialog" aria-label={title} style={{ visibility: "hidden" }}>
      <div className="dio-pick-head">
        <p className="dio-pick-title">{title}</p>
        <button type="button" className="dio-pick-close" onClick={onClose} aria-label="Close label (Escape)">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 3 6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {lines.length > 0 && (
        <ul className="dio-pick-lines">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
