/**
 * Dispatch agent (/dispatch): the Simulation Studio UI (scheduled fires, map and 3D diorama,
 * playback), with its own device-local draft, plus the live AI dispatcher beside it. Once a run
 * exists, the dispatcher builds the road network and homes around it, a deterministic monitor
 * watches the simulation every few minutes, and the agent is called only when something changes.
 * See docs/adr/0014-dispatch-agent.md, docs/adr/0017-dispatch-anywhere.md and
 * docs/adr/0018-live-dispatch-monitor.md.
 */

import SimulationStudioPage from "../studio/SimulationStudioPage";
import StudioDispatch from "./StudioDispatch";

export default function DispatchAgentPage() {
  return (
    <SimulationStudioPage
      label="Dispatch agent"
      storageNamespace="dispatch"
      aside={StudioDispatch}
    />
  );
}
