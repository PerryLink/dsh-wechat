/**
 * Host-line declaration gate — `engines.dsh`.
 *
 * `engines.dsh` is DECLARATIVE on DSH 0.2.x: `evaluatePluginCompatibility`
 * (packages/boot/app-boot/src/plugin-compatibility.ts) returns early unless
 * the manifest declares `peerDependencies`, and nothing else reads `engines`.
 * It is read by third parties instead — the plugin catalog, the doctor gate,
 * npm UIs and humans — so a wrong string is a wrong *claim* rather than a
 * runtime break, and it drifted wrong twice before:
 *
 *   1. `>=0.1.5-rc.1` alone — a floor with no ceiling that looks like it
 *      admits everything newer and in fact admits almost nothing newer.
 *   2. `>=0.1.5-rc.1 || >=0.1.7-0 <0.2.0` — the arms sit on the 0.1.5 and
 *      0.1.7 tuples, so under plain node-semver semantics (the prerelease
 *      tuple rule) EVERY 0.2.x prerelease was rejected, `0.2.0-rc.2`
 *      included. The 0.2.1 host accepted it only because it happens to pass
 *      `{ includePrerelease: true }`.
 *
 * This test pins the claim against the real `semver`, under BOTH semantics,
 * so the same class of bug cannot return silently.
 */

import { describe, expect, it } from "vitest";
import semver from "semver";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { engines?: { dsh?: string } };

const RANGE = manifest.engines?.dsh ?? "";

/** Versions the declaration must admit, under plain AND includePrerelease. */
const MUST_ADMIT = [
  "0.1.5-rc.1",
  "0.1.5-rc.2",
  "0.1.7-alpha.1",
  "0.1.7-alpha.2",
  "0.1.7-rc.2",
  "0.1.9",
  "0.2.0-rc.1",
  "0.2.0-rc.2",
  "0.2.0",
  "0.2.1-alpha.1",
  "0.2.1-alpha.2",
  "0.2.1",
];

/** Versions it must reject, under plain AND includePrerelease. */
const MUST_REJECT = [
  "0.1.4",
  "0.1.2-rc.1",
  // The old unbounded first arm admitted these; a ceiling must keep them out.
  "0.3.0-rc.1",
  "0.3.0",
  "1.0.0",
];

describe("engines.dsh declares the host lines this plugin actually runs on", () => {
  it("is a syntactically valid semver range", () => {
    expect(RANGE).not.toBe("");
    expect(semver.validRange(RANGE)).not.toBeNull();
  });

  it.each(MUST_ADMIT)("admits %s under both semver semantics", (version) => {
    expect(semver.satisfies(version, RANGE), `plain: ${version}`).toBe(true);
    expect(
      semver.satisfies(version, RANGE, { includePrerelease: true }),
      `includePrerelease: ${version}`,
    ).toBe(true);
  });

  it.each(MUST_REJECT)("rejects %s under both semver semantics", (version) => {
    expect(semver.satisfies(version, RANGE), `plain: ${version}`).toBe(false);
    expect(
      semver.satisfies(version, RANGE, { includePrerelease: true }),
      `includePrerelease: ${version}`,
    ).toBe(false);
  });

  it("covers the 0.2.0-rc.2 floor the deployment targets", () => {
    // The explicit requirement: at least 0.2.0-rc.2.
    expect(semver.satisfies("0.2.0-rc.2", RANGE, { includePrerelease: true })).toBe(true);
    expect(semver.satisfies("0.2.0-rc.2", RANGE)).toBe(true);
  });

  it("does not declare a peer that would turn the install gate on by accident", () => {
    // `engines.dsh` is not enforced; `peerDependencies` are, and a wrong peer
    // range makes the host SKIP the whole bundle layer
    // (packages/boot/app-boot/src/profile.ts). The plugin deliberately has no
    // runtime `@deepseek-ai/*` dependency, so it must not declare one either.
    const peers = (JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { peerDependencies?: Record<string, string> }).peerDependencies;
    expect(peers ?? {}).not.toHaveProperty("@deepseek-ai/dsh");
  });
});
