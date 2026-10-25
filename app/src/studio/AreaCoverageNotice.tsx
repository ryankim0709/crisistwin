/**
 * Says which part of the board has modelled roads and evacuation, and what falls outside it
 * (studio/areaCoverage.ts), so a fire outside the area never reads as "no threat".
 */

import { Notice } from "../ui";
import type { AreaCoverage } from "./areaCoverage";

/** Below this, developed ground reached outside the area is noise (a few edge cells). */
const MIN_REPORTED_HECTARES = 1;

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function AreaCoverageNotice({
  coverage,
  className,
}: {
  coverage: AreaCoverage | null;
  className?: string;
}) {
  if (!coverage) return null;
  const { areaName, part, firesOutside, developedOutsideHectares } = coverage;
  const developed = developedOutsideHectares !== null && developedOutsideHectares >= MIN_REPORTED_HECTARES;
  if (!part && firesOutside.length === 0 && !developed) return null;
  const where = part ? ` (${part} of the board)` : "";
  return (
    <Notice
      compact
      tone={firesOutside.length > 0 || developed ? "warning" : "info"}
      title="Roads modelled:"
      className={className}
    >
      {areaName}
      {where} only.
      {firesOutside.length > 0 &&
        ` ${list(firesOutside)} ${firesOutside.length === 1 ? "is" : "are"} outside it: no evacuation or units for ${firesOutside.length === 1 ? "it" : "them"}.`}
      {developed &&
        ` The fire reaches ${Math.round(developedOutsideHectares).toLocaleString()} ha of developed land outside it; those homes are not modelled.`}
    </Notice>
  );
}
