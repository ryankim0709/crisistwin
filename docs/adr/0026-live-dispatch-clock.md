# 0026: The dispatcher works on a live clock

Date: 2026-10-24. Status: accepted for the demo. Amends
[0019-live-dispatch-monitor](0019-live-dispatch-monitor.md) and
[0025-dispatch-fire-tactics](0025-dispatch-fire-tactics.md).

## Context

When the monitor woke the agent, the session stopped the clock until the answer arrived, so the
fire, traffic and engines waited for the model. A real dispatch centre has no pause: the fire
keeps spreading while a dispatcher decides, and engines take time to turn out and drive. A
decision that takes too long, or engines sent too late, should cost something in the
simulation.

## Decision

- **The clock keeps running while the agent thinks** (`useDispatchSession.ts`). The engine keeps
  stepping at the playback speed; the monitor does not check while a decision is in flight.
  The agent decides on the situation it was shown (minute m0); its orders apply when the answer
  arrives (minute m1), from wherever everything is then. The log shows both minutes.
- **No change is missed.** Later checks compare against what the agent saw at m0, and the
  monitor checks again as soon as orders apply, so anything material that happened during the
  thinking time wakes it again.
- **Speeds are real-time ratios**: real time (1/60 simulated minute per second), 10×, 30× and
  60× (the former 1 min/s); 30× by default. At 30× a 20 s decision costs 10 simulated minutes.
- **The agent is told and the options include it.** The observation carries
  `clock.decision_delay_min` (the previous decision's delay in simulated minutes; before the
  first, 15 s of real time at the playback speed) and a model note; `tactic_options` assume the
  engines leave after that delay, so their containment times and homes reached include the
  fire's growth meanwhile. The prompt asks for brief, decisive answers.
- **Turnout.** An engine sent from its station waits 80 s (NFPA 1710) before driving, also when
  its assignment is at its own station's node (it was previously on scene at once there). Line
  building starts the whole minute after arrival, in both the engine and the estimate, so the
  estimated and actual put-out minutes agree.

## Consequences

- Slow decisions and late dispatches now show up as larger fires, more homes reached and
  sometimes a fire that can no longer be held.
- At real time a 3 h scenario takes 3 h; 30× (6 minutes) is the demo default.
- The fire re-solves and option solves still run on the main thread; their compute time is not
  charged to the clock (the clock advances at most 0.1 s of real time per frame).
- Decisions are still one at a time: a change found while the agent is thinking waits until its
  answer arrives.
