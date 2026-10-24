// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPRESSION_DATA } from "./suppressionData.generated";

/**
 * The generated module must match tools/suppression_resources.json leaf for leaf (value, unit
 * and provenance). Regenerate with `python3 -m tools.gen_suppression_ts` after editing the data.
 */
const json = JSON.parse(
  readFileSync(new URL("../../../tools/suppression_resources.json", import.meta.url), "utf-8"),
) as Record<string, unknown>;

function leafAt(path: string): Record<string, unknown> | undefined {
  let node: unknown = json;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node as Record<string, unknown> | undefined;
}

describe("suppression data module", () => {
  it("is in sync with tools/suppression_resources.json", () => {
    const paths = Object.keys(SUPPRESSION_DATA.leaves);
    expect(paths.length).toBeGreaterThan(50);
    for (const path of paths) {
      const leaf = leafAt(path);
      const generated = SUPPRESSION_DATA.leaves[path];
      expect(leaf, path).toBeDefined();
      expect(generated.value, path).toEqual(leaf!.value);
      expect(generated.unit, path).toBe(leaf!.unit);
      if (leaf!.assumption === true) {
        expect(generated.assumption, path).toBe(true);
        expect(generated.reason, path).toBe(leaf!.reason);
      } else {
        expect(generated.source, path).toBe(leaf!.source_id);
        expect(generated.page, path).toBe(leaf!.page);
      }
    }
    expect(SUPPRESSION_DATA.generated).toBe((json.meta as { generated: string }).generated);
  });

  it("keeps every number sourced or flagged as an assumption", () => {
    for (const [path, leaf] of Object.entries(SUPPRESSION_DATA.leaves)) {
      expect(leaf.assumption === true || (!!leaf.source && !!leaf.page), path).toBe(true);
    }
  });
});
