import { useEffect, useRef, useState } from "react";
import { Button, LoadingState, Notice, Tag } from "../ui";
import {
  activate,
  CAMP_OPTION,
  fetchPackages,
  isCurrent,
  type ActivateTarget,
  type ActiveIncident,
  type StoredPackage,
} from "./active";
import { LiveError } from "./api";
import "./invite.css";

interface Option {
  key: string;
  name: string;
  detail: string;
  target: ActivateTarget;
}

const created = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

const packageOption = (p: StoredPackage): Option => ({
  key: p.package_id,
  name: p.summary.name,
  detail: [
    p.summary.place,
    `${p.summary.zones} zones · ${p.summary.homes.toLocaleString()} homes`,
    created(p.created_at),
  ]
    .filter(Boolean)
    .join(" · "),
  target: { package_id: p.package_id },
});

/** "Drill": choose which wildfire the whole instance runs (Camp or a Studio package). */
export default function DrillPicker({
  token,
  active,
  onSwitched,
  onClose,
}: {
  token: string;
  active: ActiveIncident | null;
  onSwitched: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [packages, setPackages] = useState<StoredPackage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Option | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetchPackages(token, controller.signal)
      .then(setPackages)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(e instanceof LiveError ? e.message : "Could not load the drills.");
      });
    return () => controller.abort();
  }, [token]);

  const options: Option[] = [
    { key: CAMP_OPTION.incident_id, name: CAMP_OPTION.name, detail: "", target: { incident_id: CAMP_OPTION.incident_id } },
    ...(packages ?? []).map(packageOption),
  ];

  const confirm = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      await activate(token, confirming.target);
      onSwitched();
      dialog.current?.close();
    } catch (e) {
      setError(e instanceof LiveError ? e.message : "Could not switch the drill.");
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="lc-invite lc-pick" aria-labelledby="lc-pick-title" onClose={onClose}>
      <h2 id="lc-pick-title">Drill</h2>
      {confirming ? (
        <>
          <p>
            Switch the live drill to {confirming.name}? Every console and phone moves to this fire.
          </p>
          {error ? (
            <Notice tone="danger" compact>
              {error}
            </Notice>
          ) : null}
          <div className="lc-invite-actions">
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>
              Back
            </Button>
            <Button disabled={busy} onClick={() => void confirm()}>
              {busy ? "Switching…" : "Switch drill"}
            </Button>
          </div>
        </>
      ) : (
        <>
          {loadError ? (
            <Notice tone="danger" compact>
              {loadError}
            </Notice>
          ) : null}
          {!packages && !loadError ? <LoadingState>Loading drills…</LoadingState> : null}
          <ul className="lc-pick-list">
            {options.map((o) => {
              const current = isCurrent(active, o.target);
              return (
                <li key={o.key} className="lc-pick-row">
                  <span className="lc-pick-text">
                    <strong>{o.name}</strong>
                    {o.detail ? <small className="lc-dim">{o.detail}</small> : null}
                  </span>
                  {current ? (
                    <Tag tone="brand">Active</Tag>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setConfirming(o)}>
                      Activate
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {packages && packages.length === 0 ? (
            <p className="lc-dim">No Studio drills yet. Build one in Simulation Studio.</p>
          ) : null}
          <div className="lc-invite-actions">
            <Button variant="secondary" onClick={() => dialog.current?.close()}>
              Close
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
