# 0009: Solver direction set

Date: 2026-10-23. Status: accepted.

Amends [0004](0004-physics-fire-model.md) and [0007](0007-wui-spread-mechanisms.md), and is
a separate decision from [0008](0008-crown-fire.md) though both landed in the same branch
and both move the numbers 0007 reports. 0008 adds a mechanism; this entry fixes a solver
that was misrepresenting the ellipse the surface and crown models were already asking it to
draw. Nothing about the fuel physics, the fuel table, or the crown fire decision changes
here. Only `buildStencil`'s radius and the barrier check a multi-cell step applies in
`spread.ts` change.

## Why

Minimum travel time over a lattice reaches exactly the convex hull of the per-direction
rate vectors the stencil offers it, so the fire the solver actually draws is a polygon
inscribed in the ellipse the model intends, not the ellipse itself. How much that polygon
falls short of the ellipse is set by the stencil's single finest off-axis direction, and at
the length-to-breadth values this model runs at in wind-driven fuels that direction was far
too coarse.

At the `MAX_LENGTH_TO_BREADTH` cap of 8 the ellipse's eccentricity is 0.992 and its widest
point sits only 7.2 degrees off the heading. The direction set shipped at this decision's
start had a radius of 2, whose finest off-axis offset is `atan(1/2)`, 26.6 degrees from the
heading — nowhere near fine enough to find that widest point — and at 26.6 degrees off an
elongated heading the directional rate has already fallen to about 7 percent of the head
rate. Measured against the intended ellipse at length-to-breadth 8, the radius-2 stencil
produced a breadth of 403 m against an intended 856 m and an area of 149 ha against an
intended 461 ha, and the effective length-to-breadth the discrete fire actually drew out
was 17.06 against the 8.00 the model was asking for — not a rounding error, but a fire
roughly half as wide and a third the area it was supposed to be. The same coarseness cost
length as well as breadth: at wind bearings that fell unluckily between lattice directions,
forward reach fell to as little as 0.223 of the analytic head distance, so rotating the
same scenario changed the answer by more than rotating a real fire would.

## Decision

`NEIGHBOUR_STENCIL_RADIUS` moves from 2 to 8, which is 176 directions after dropping offsets
that share a common factor (duplicates of a shorter step in the same direction, carrying no
information). At radius 8 the breadth recovers to 876 m and the effective length-to-breadth
to 7.84 against the intended 8.00, both close enough that the discrete fire is a reasonable
stand-in for the ellipse at the cap this model actually runs at. Richer stencils were not
pursued past this point: the cost is in neighbours touched per settle, and a 30 m grid at
this radius still settles in well under the budget a re-solve on a control change needs.

This did not come for free along the other axis the radius-2 stencil was wrong on. A step
of up to 8 cells can cross a non-burnable barrier — a one-cell-wide road or stream — without
ever landing a candidate step on it, if only the *endpoint* of the step is checked for
passability. The radius-2 stencil's own guard already had this problem in miniature, since
a two-cell step accepted the offer when *either* candidate midpoint was passable, and
generalising that rule to eight-cell steps leaks badly: tested against a one-cell water
barrier with nothing beyond it, the lenient rule let 417 cells ignite on the far side, which
is fire crossing up to 190 m of road, river, or firebreak in a single hop. The fix walks
every cell a step passes over — `round(dx * s / steps), round(dy * s / steps)` for each
intermediate position — and requires all of them to be passable, not just one. That rule
was tested at radius 2, 6, and 8 against barriers 1, 2, 4, 8, and 9 cells wide, with nothing
beyond the wall in every case, and no cell ignited on the far side at any combination.

## What this is not

The remaining gap is recorded, not claimed solved. At radius 8 the worst-case forward reach
at an unlucky wind bearing improved from 0.223 of analytic to 0.808 — a real improvement,
not a fix. A fire whose heading happens to fall between two of the 176 lattice directions
still reaches about 19 percent short of where the ellipse says it should, and that residual
is a property of any finite direction set on a lattice, not something a larger radius alone
removes in the limit: it shrinks with radius but does not go to zero within a range this
model can afford to search every settle. Closing it fully would need either a lower
`MAX_LENGTH_TO_BREADTH` — rejected for the same reason 0007 rejected it, that FARSITE uses
the same cap and observed wind-driven ratios reach it — or a solver that advances along each
cell's own continuous heading instead of along lattice directions, which this entry does not
attempt.

## What it changes, and what it does not excuse

Every area and reach figure 0007 reports for a run before this decision was measured on a
solver that was under-drawing its own intended ellipse by a factor of roughly 2 to 4.5 in
area. That does not mean those figures were simply too small by a fixed factor: the error
is direction-dependent and wind-speed-dependent, so it changed the *shape* of those runs,
not only their size. [0008](0008-crown-fire.md) records the one place this is known to
matter: a chaparral control that calibration had placed within about 1.5 times the observed
Palisades Fire moved to roughly 3 times that anchor once this fix landed, and the honest
reading is that the 1.5 figure was never a sound anchor, because it was measured against a
solver that was losing most of its own ellipse in a way that happened to partially cancel
against whatever the surface model was already doing. This entry fixes the solver geometry;
it does not revisit the chaparral disagreement that fixing it exposed, which stays open in
0008.

Outputs remain planning experiments, not operational evacuation instructions.
