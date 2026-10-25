// Header drop-in for saving and loading shared-world scenarios (docs/shared-world.md).
//   <ScenarioMenu tab="fire" getExtras={() => fireExtras} onLoaded={(s) => applyFire(s.extras.fire)} />
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, EmptyState, Field, LoadingState, Notice, Panel, Tag, cx } from "../ui";
import type { Scenario, ScenarioExtras, ScenarioTab, WorldWriter } from "./contracts";
import { useScenarios } from "./useScenarios";
import { useWorld } from "./useWorld";
import "./world.css";

const TABS: readonly ScenarioTab[] = ["fire", "simulation", "dispatch", "live"];

export interface ScenarioMenuProps {
  /** The tab saving and loading (recorded as `updatedBy`; its extras key when it is a tab). */
  tab: WorldWriter;
  /** This tab's extras to save with the world (opaque JSON, ≤ 2 MB). */
  getExtras?: () => unknown;
  /** Called after a scenario's world became the active world, with the full scenario. */
  onLoaded?: (scenario: Scenario) => void;
  /** Open the panel to the left of the button (default) or to the right. */
  align?: "end" | "start";
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
      const extras: ScenarioExtras = {};
      const ownExtras = getExtras?.();
      if (ownExtras !== undefined && (TABS as readonly string[]).includes(tab)) {
        extras[tab as ScenarioTab] = ownExtras;
      }
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
          className={cx("wld-menu__panel", align === "start" && "wld-menu__panel--start")}
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
