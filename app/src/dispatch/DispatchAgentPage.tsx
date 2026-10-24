/**
 * Dispatch agent (/dispatch): the Simulation Studio UI (scheduled fires, map and 3D diorama,
 * playback), with its own device-local draft. The AI dispatcher (engine, console, OSM area,
 * diorama overlay) still lives in this folder but is not wired into the page yet; it will
 * run on top of the studio result. See docs/adr/0014-dispatch-agent.md and
 * docs/adr/0017-dispatch-anywhere.md.
 */

import SimulationStudioPage from "../studio/SimulationStudioPage";

export default function DispatchAgentPage() {
  return <SimulationStudioPage label="Dispatch agent" storageNamespace="dispatch" />;
}
