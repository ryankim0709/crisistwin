/** "T+h:mm" for a board minute (minutes from scenario T+0); "T+—" for null. */
export function formatClock(minute: number | null): string {
  if (minute === null || !Number.isFinite(minute)) return "T+—";
  const m = Math.max(0, Math.floor(minute));
  return `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** "4 h" / "1 h 30 min" for a duration in minutes. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
