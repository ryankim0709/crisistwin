/** Helpers shared by Simulation Studio and the dispatch agent page. */

/** Index of the last frame at or before `minute`. */
export function frameIndexAt(frameMinutes: readonly number[], minute: number): number {
  let index = 0;
  for (let i = 0; i < frameMinutes.length; i += 1) {
    if (frameMinutes[i] <= minute) index = i;
    else break;
  }
  return index;
}

export function downloadJson(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
