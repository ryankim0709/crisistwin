import "./live.css";
import type { BroadcastStatus } from "./useLiveBroadcast";

function describe(status: BroadcastStatus, idleText: string): string {
  switch (status.state) {
    case "off":
      return "Not shared with the resident app.";
    case "waiting":
      return idleText;
    case "sent":
      return `Resident app sees T+${Math.round(status.minute)} min (simulated).`;
    case "error":
      return `Could not share: ${status.message}`;
  }
}

/** Switch and status line for the resident-app broadcast. Status text never relies on colour. */
export function LiveShareToggle({
  id,
  enabled,
  onChange,
  status,
  idleText = "Shares once a run exists.",
  className,
}: {
  id: string;
  enabled: boolean;
  onChange: (on: boolean) => void;
  status: BroadcastStatus;
  idleText?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <input id={id} type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id}>Share with resident app</label>
      <p className="live-share__status" role="status" data-state={status.state}>
        {describe(status, idleText)}
      </p>
    </div>
  );
}
