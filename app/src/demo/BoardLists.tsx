import { Button, EvidenceTag, LoadingState, Notice, Tag } from "../ui";
import type { Selection } from "./DemoMap";
import { FIRE_STATUS, SOURCE_LABEL, TEAM_STATUS, simClock } from "./format";
import { currentContainment, fireAreaHa } from "./model";
import { kindShort } from "./realism";
import type { CommandBoard } from "./useCommandBoard";

/** The simulated board's "Active fires" and "Units" lists (left column of /live). */
export default function BoardLists({
  board: cb,
  onSelect,
}: {
  board: CommandBoard;
  onSelect: (selection: Selection) => void;
}) {
  const { board, fires, selection, totals: t } = cb;
  if (!board || !t) {
    return (
      <section className="lc-col lc-board" aria-label="Simulated fires and firefighting units">
        {cb.environment.error ? (
          <Notice tone="danger" compact>
            {cb.environment.error}{" "}
            <Button size="sm" variant="secondary" onClick={cb.retryEnvironment}>
              Retry
            </Button>
          </Notice>
        ) : (
          <LoadingState>
            {cb.environment.liveLandscape
              ? "No stored landscape covers this drill: loading its fuel, canopy and terrain live from LANDFIRE (this takes longer)…"
              : "Loading wind, landscape and fire stations…"}
          </LoadingState>
        )}
      </section>
    );
  }
  return (
    <section className="lc-col lc-board" aria-label="Simulated fires and firefighting units">
      <div className="lc-col-head">
        <h2>Active fires</h2>
        <span className="lc-dim lc-num">
          {t.burning} burning, {t.contained} contained
        </span>
      </div>
      <p className="lc-board-note">
        <EvidenceTag kind="simulated" /> Board fires and units run in this browser; fire reports from the drill start fires here.
      </p>
      {cb.fireSolver.error ? (
        <Notice tone="danger" compact>
          Fire model failed, clock held (retrying): {cb.fireSolver.error}
        </Notice>
      ) : cb.fireSolver.solving ? (
        <p className="lc-board-note lc-dim">Fire model updating ({cb.fireSolver.solving}); clock held…</p>
      ) : null}
      <div className="lc-col-scroll">
        {fires.length === 0 ? (
          <p className="dm-empty">No active fires. Watching for ignitions and field reports.</p>
        ) : (
          <ul className="lc-q-list" role="listbox" aria-label="Active fires">
            {fires.map((f) => {
              const crews = board.teams.filter((tm) => tm.fireId === f.id).map((tm) => tm.id);
              const eta = f.status === "burning" ? currentContainment(board, f) : null;
              const selected = selection?.kind === "fire" && selection.id === f.id;
              return (
                <li
                  key={f.id}
                  role="option"
                  aria-selected={selected}
                  tabIndex={0}
                  className={`lc-q-row dm-fire-row${selected ? " is-selected" : ""}`}
                  onClick={() => onSelect({ kind: "fire", id: f.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect({ kind: "fire", id: f.id });
                    }
                  }}
                >
                  <span className={`dm-fire-glyph dm-fire-glyph--${f.status}`} aria-hidden="true" />
                  <span className="lc-q-body">
                    <span className="lc-q-title">
                      <strong>{f.id}</strong>
                      <Tag tone={FIRE_STATUS[f.status].tone}>{FIRE_STATUS[f.status].label}</Tag>
                      <Tag>{SOURCE_LABEL[f.source]}</Tag>
                    </span>
                    <span className="lc-q-meta lc-num">
                      {fireAreaHa(f).toFixed(1)} ha · {f.headRate} m/min · flame {Math.round(f.rates.headFlameFeet)} ft
                      {f.noSpread ? ` · ${f.noSpread}` : f.status === "burning" && f.rates.crowning ? " · crown fire at head" : ""} · started{" "}
                      {simClock(f.ignitedAt)}
                    </span>
                    <span className={`lc-q-meta${f.status === "burning" && (crews.length === 0 || eta === null) ? " lc-error" : ""}`}>
                      {f.status !== "burning"
                        ? "Mopping up"
                        : crews.length === 0
                          ? "No units assigned"
                          : `${crews.join(", ")} · ${eta === null ? "outrunning its units" : `contained in about ${eta} min`}`}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="lc-col-head">
          <h2>Units</h2>
          <span className="lc-dim lc-num">{board.teams.filter((tm) => tm.status === "available").length} free</span>
        </div>
        <ul className="dm-teams">
          {board.teams.map((tm) => (
            <li key={tm.id}>
              <button
                type="button"
                className="dm-team"
                aria-pressed={selection?.kind === "team" && selection.id === tm.id}
                onClick={() => onSelect({ kind: "team", id: tm.id })}
              >
                <strong>{tm.id}</strong>
                <span className="lc-dim">{kindShort(tm.kind)}</span>
                <span className={`dm-team-status dm-team-status--${tm.status}`}>{TEAM_STATUS[tm.status]}</span>
                <span className="lc-dim">
                  {tm.fireId ?? board.stations.find((s) => s.id === tm.station)?.name}
                  {tm.status === "en_route" && tm.arriveAt !== null ? `, ${Math.ceil(tm.arriveAt - board.minute)} min` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
