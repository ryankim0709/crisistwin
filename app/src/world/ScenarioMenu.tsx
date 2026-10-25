// Header drop-in for saving and loading shared-world scenarios (docs/shared-world.md).
//   <ScenarioMenu tab="fire" getExtras={() => fireExtras} onLoaded={(s) => applyFire(s.extras.fire)} />
// Every open workspace tab in this browser takes part: saving asks the other tabs for their
// extras (BroadcastChannel "crisistwin-world-extras"), and loading tells them to restore theirs,
// so one saved scenario restores all tabs. A tab with sync turned off neither gives nor takes.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, EmptyState, Field, LoadingState, Notice, Panel, Tag, cx } from "../ui";
import type { Scenario, ScenarioExtras, ScenarioTab, WorldWriter } from "./contracts";
import { useScenarios } from "./useScenarios";
import { useWorld } from "./useWorld";
import "./world.css";

const TABS: readonly ScenarioTab[] = ["fire", "simulation", "dispatch", "live"];
const EXTRAS_CHANNEL = "crisistwin-world-extras";
/** How long a save waits for the other tabs' extras. */
const EXTRAS_WAIT_MS = 400;

type ExtrasMessage =
  | { type: "extras-request"; id: string }
  | { type: "extras-reply"; id: string; tab: ScenarioTab; extras: unknown }
  | { type: "scenario-loaded"; scenario: Scenario };

const isTab = (tab: WorldWriter): tab is ScenarioTab => (TABS as readonly string[]).includes(tab);

/** Ask the other tabs in this browser for their extras. */
async function gatherExtras(): Promise<ScenarioExtras> {
  if (typeof BroadcastChannel === "undefined") return {};
  const channel = new BroadcastChannel(EXTRAS_CHANNEL);
  const id = Math.random().toString(36).slice(2);
  const extras: ScenarioExtras = {};
  channel.onmessage = (event: MessageEvent<ExtrasMessage>) => {
    const data = event.data;
    if (data?.type === "extras-reply" && data.id === id && extras[data.tab] === undefined) {
      extras[data.tab] = data.extras;
    }
  };
  channel.postMessage({ type: "extras-request", id } satisfies ExtrasMessage);
  await new Promise((resolve) => window.setTimeout(resolve, EXTRAS_WAIT_MS));
  channel.close();
  return extras;
}

function announceLoaded(scenario: Scenario): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(EXTRAS_CHANNEL);
  channel.postMessage({ type: "scenario-loaded", scenario } satisfies ExtrasMessage);
  channel.close();
}

export interface ScenarioMenuProps {
  /** The tab saving and loading (recorded as `updatedBy`; its extras key when it is a tab). */
  tab: WorldWriter;
  /** This tab's extras to save with the world (opaque JSON, ≤ 2 MB). */
  getExtras?: () => unknown;
  /** Called after a scenario's world became the active world, with the full scenario. */
  onLoaded?: (scenario: Scenario) => void;
  /** Open the panel to the left of the button (default) or to the right. */
  align?: "end" | "start";
  /** Open the panel below the button (default) or above it (a control at the bottom of a stage). */
  placement?: "down" | "up";
  /** False when this tab is not synced: it then neither gives extras to nor takes them from other tabs. */
  syncEnabled?: boolean;
  className?: string;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const utcDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

function when(iso: string | null | undefined, format: Intl.DateTimeFormat): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? format.format(t) : "—";
}

export function ScenarioMenu({
  tab,
  getExtras,
  onLoaded,
  align = "end",
  placement = "down",
  syncEnabled = true,
  className,
}: ScenarioMenuProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const { world, loaded } = useWorld();
  const { scenarios, status, error, save, load, remove } = useScenarios(tab, open);

  // Answer other tabs' extras requests and restore this tab's extras when another tab loads.
  const latest = useRef({ getExtras, onLoaded, syncEnabled, tab });
  useEffect(() => {
    latest.current = { getExtras, onLoaded, syncEnabled, tab };
  });
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(EXTRAS_CHANNEL);
    channel.onmessage = (event: MessageEvent<ExtrasMessage>) => {
      const data = event.data;
      const own = latest.current;
      if (!own.syncEnabled || !isTab(own.tab)) return;
      if (data?.type === "extras-request" && own.getExtras) {
        const extras = own.getExtras();
        if (extras !== undefined) {
          channel.postMessage({ type: "extras-reply", id: data.id, tab: own.tab, extras } satisfies ExtrasMessage);
        }
      } else if (data?.type === "scenario-loaded") {
        own.onLoaded?.(data.scenario);
      }
    };
    return () => channel.close();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "World API error.");
    } finally {
      setBusy(null);
    }
  };

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    void run("save", async () => {
      const extras: ScenarioExtras = syncEnabled ? await gatherExtras() : {};
      const ownExtras = getExtras?.();
      if (ownExtras !== undefined && isTab(tab)) extras[tab] = ownExtras;
      const scenario = await save({ name: name.trim(), notes: notes.trim(), world, extras });
      setSaved(scenario.name);
      setName("");
      setNotes("");
      setSaving(false);
    });
  };

  const onLoad = (id: string) =>
    void run(`load:${id}`, async () => {
      const scenario = await load(id);
      setOpen(false);
      onLoaded?.(scenario);
      if (syncEnabled) announceLoaded(scenario);
    });

  const onDelete = (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    void run(`delete:${id}`, async () => {
      await remove(id);
      setConfirmDelete(null);
    });
  };

  return (
    <div ref={root} className={cx("wld-menu", className)}>
      <Button
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((o) => !o);
          setSaved(null);
          setActionError(null);
        }}
      >
        Scenarios
      </Button>
      {open && (
        <Panel
          compact
          role="dialog"
          aria-label="Scenarios"
          title="Scenarios"
          className={cx(
            "wld-menu__panel",
            align === "start" && "wld-menu__panel--start",
            placement === "up" && "wld-menu__panel--up",
          )}
          aside={
            !saving && (
              <Button size="sm" variant="soft" onClick={() => setSaving(true)} disabled={!loaded}>
                Save scenario…
              </Button>
            )
          }
        >
          {saving && (
            <form className="wld-menu__form" onSubmit={onSave}>
              <Field label="Name">
                <input
                  value={name}
                  maxLength={120}
                  required
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Notes">
                <textarea
                  value={notes}
                  maxLength={4000}
                  rows={3}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
              <div className="wld-menu__actions">
                <Button type="submit" size="sm" disabled={!name.trim() || busy === "save"}>
                  {busy === "save" ? "Saving…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSaving(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {saved && !saving && (
            <Notice tone="success" compact>
              Saved “{saved}”.
            </Notice>
          )}
          {actionError && (
            <Notice tone="danger" compact>
              {actionError}
            </Notice>
          )}
          {status === "loading" && scenarios.length === 0 ? (
            <LoadingState>Loading scenarios…</LoadingState>
          ) : status === "error" && scenarios.length === 0 ? (
            <Notice tone="danger" compact>
              {error ?? "Could not list scenarios."}
            </Notice>
          ) : scenarios.length === 0 ? (
            <EmptyState title="No saved scenarios" />
          ) : (
            <ul className="wld-menu__list">
              {scenarios.map((s) => (
                <li key={s.id} className="wld-menu__item">
                  <div className="wld-menu__meta">
                    <strong>{s.name}</strong>
                    <span>
                      {s.region?.name ?? "—"} · {when(s.startUtc, utcDate)} UTC
                    </span>
                    <span>
                      Saved {when(s.createdAt, dateTime)}
                      {s.updatedBy ? ` from ${s.updatedBy}` : ""}
                    </span>
                    {s.notes && <span className="wld-menu__notes">{s.notes}</span>}
                    {s.extrasKeys.length > 0 && (
                      <span className="wld-menu__tags">
                        {s.extrasKeys.map((k) => (
                          <Tag key={k}>{k}</Tag>
                        ))}
                      </span>
                    )}
                  </div>
                  <div className="wld-menu__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => onLoad(s.id)}
                    >
                      {busy === `load:${s.id}` ? "Loading…" : "Load"}
                    </Button>
                    <Button
                      size="sm"
                      variant={confirmDelete === s.id ? "danger" : "ghost"}
                      disabled={busy !== null}
                      onClick={() => onDelete(s.id)}
                      onBlur={() => setConfirmDelete((c) => (c === s.id ? null : c))}
                    >
                      {confirmDelete === s.id ? "Confirm delete" : "Delete"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
