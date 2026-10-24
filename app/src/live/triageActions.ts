import { triageReport } from "./api";
import type { QueueItem } from "./queue";
import type { RunAction } from "./SelectedItem";

export type TriageKind = "confirm" | "dismiss" | "resolve";

/** The same calls SelectedItem's Confirm, Resolve and Dismiss buttons make; null when not applicable. */
export function triageItem(run: RunAction, item: QueueItem, kind: TriageKind): Promise<string | null> | null {
  if (item.reports.length === 0) return null;
  const key = `item:${item.id}`;
  if (kind === "confirm") {
    if (item.confirmed) return null;
    const lead = item.reports.find((r) => r.kind === item.kind && r.status !== "confirmed") ?? item.reports[0];
    return run(key, (t) => triageReport(t, lead.id, "confirm"));
  }
  if (kind === "resolve") {
    if (!item.confirmed) return null;
    return run(key, async (t) => {
      for (const r of item.reports.filter((r) => r.status === "confirmed")) await triageReport(t, r.id, "resolve");
    });
  }
  return run(key, async (t) => {
    for (const r of item.reports) await triageReport(t, r.id, "dismiss");
  });
}
