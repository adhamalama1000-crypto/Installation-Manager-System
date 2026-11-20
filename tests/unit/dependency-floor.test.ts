import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Security floors for the framework, checked against the versions that are actually installed and
 * would be loaded at runtime (not the ranges written in package.json):
 *
 * - next >= 16.4.5: fixes GHSA-mfr8-8qww-v76h, GHSA-vc7v-qv4w-wrv8, GHSA-7qx7-33qx-rqx2,
 *   GHSA-f3mh-rxg3-f5g2, GHSA-pc58-hwjq-p385, GHSA-rhh4-g77r-r9qj and GHSA-vvgp-ww4w-46vf
 *   (all affect 16.0.0 - 16.4.4). GHSA-2464-fhr4-w9xw (image optimization RCE) affects
 *   16.0.0 - 16.4.0 and is patched in 16.4.1.
 * - sharp >= 0.35.5 as resolved FROM next (the copy next/image optimization loads): the
 *   workaround named by GHSA-2464-fhr4-w9xw.
 */
const NEXT_FLOOR = "16.4.5";
const SHARP_FLOOR = "0.35.5";

function compare(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const fromRoot = createRequire(path.resolve(__dirname, "../../package.json"));

function resolvedNext() {
  const file = fromRoot.resolve("next/package.json");
  return { file, version: (fromRoot(file) as { version: string }).version };
}

describe("dependency security floors (resolved versions)", () => {
  it("compares versions numerically", () => {
    expect(compare("16.4.6", "16.4.5")).toBeGreaterThan(0);
    expect(compare("16.4.10", "16.4.5")).toBeGreaterThan(0);
    expect(compare("16.4.4", "16.4.5")).toBeLessThan(0);
    expect(compare("0.35.5", "0.35.5")).toBe(0);
    expect(compare("0.34.9", "0.35.5")).toBeLessThan(0);
  });

  it(`resolves next >= ${NEXT_FLOOR}`, () => {
    const { version } = resolvedNext();
    expect(compare(version, NEXT_FLOOR), `installed next ${version}`).toBeGreaterThanOrEqual(0);
  });

  it(`resolves sharp >= ${SHARP_FLOOR} from next (the copy used for image optimization)`, () => {
    // Resolve sharp's entry point exactly as next would (sharp does not export its package.json),
    // then read the package.json of the package that entry belongs to.
    const fromNext = createRequire(resolvedNext().file);
    let dir = path.dirname(fromNext.resolve("sharp"));
    let pkg: { name?: string; version: string } | null = null;
    let file = "";
    while (!pkg) {
      file = path.join(dir, "package.json");
      if (existsSync(file)) {
        const p = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version: string };
        if (p.name === "sharp") pkg = p;
      }
      const up = path.dirname(dir);
      if (up === dir) throw new Error("sharp package.json not found");
      if (!pkg) dir = up;
    }
    const { version } = pkg;
    expect(compare(version, SHARP_FLOOR), `sharp ${version} at ${file}`).toBeGreaterThanOrEqual(0);
  });
});
