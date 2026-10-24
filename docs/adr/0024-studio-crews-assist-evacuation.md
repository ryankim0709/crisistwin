# 0024: Overwhelmed Studio crews help the evacuation

Date: 2026-10-24. Status: accepted for the demo. Builds on
[0018-road-closures](0018-road-closures.md), [0020-studio-firefighting](0020-studio-firefighting.md)
and [0023-studio-crew-dispatch](0023-studio-crew-dispatch.md).

## Context

Studio firefighters drive in from fire stations and attack the fire (ADR 0023), but when they
cannot put it out they simply stayed at the fire for the rest of the run. Crews who are
overwhelmed by a fire switch to protecting people: knocking on doors and moving residents out.

## Decision

- **When crews are overwhelmed** (`app/src/studio/crewHandoff.ts`, pure). If the direct-attack
  estimate leaves any fire burning (it is crowning, its head flame is longer than the crews can
  hold, or their line cannot catch its edge by the horizon), each crew leaves the fire
  `SIZE_UP_MINUTES` (an assumed 10 min) after it arrived, or after the last fire they did put
  out if that is later. When every fire goes out, crews stay with it. The reason is shown in the
  results panel.
- **Only with the direct-attack fire shown.** With the line plan shown, crews keep building line;
  with "No crews" there are none.
- **Evacuation support** (`app/src/studio/evacuation.ts`). Leaving crews join the Studio's
  evacuation run as dispatch-engine units (`DispatchEngine.addUnit`) on `evacuation_support`,
  which shortens a zone's departure spread from 45 to 20 minutes while one is on scene (the
  engine's existing model). Every 5 simulated minutes an idle crew (just left the fire, withdrawn,
  or in a zone that has cleared) goes to the ordered zone with the fewest crews, then the earliest
  fire contact, then the most households still at home, skipping zones whose core the fire
  reaches within 15 minutes. A crew whose road point the fire has already cut off from every
  zone still evacuating first pulls back to the nearest road node that can reach one. Crews
  withdraw, or are cut off, under the engine's usual rules.
- **Display.** In 3D the crews disappear from the fire when they leave; the label there counts
  them ("9 overwhelmed, helping evacuate"). With Evacuation & closures on, the dispatch overlay
  draws them driving to and working in their zones.

## Consequences

- On the demo fires under critical moisture, all nine resources are overwhelmed and leave
  between T+0:28 and T+0:38. They support zones Z28–Z52 near the fire, and two are cut off by
  the fire on the way, as the engine's routing rules imply.
- The size-up time and zone choice are assumptions, not doctrine. Crews do not return to the
  fire if conditions ease, the estimate is the rough one of ADR 0020, and the evacuation panel
  does not yet report the crews' effect separately.
