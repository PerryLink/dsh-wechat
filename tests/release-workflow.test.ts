/**
 * Release pipeline guard.
 *
 * The release flow has one property that matters above all others: **a
 * failure must not produce a half-published release.** This fork creates a
 * GitHub Release but deliberately does **not** publish to npm: the bare
 * `dsh-wechat` name belongs to upstream `pan17/dsh-wechat`. The npm job is
 * therefore an explicit, tested no-op, and a tag that disagrees with
 * `package.json` must fail before the Release exists.
 *
 * These assertions are static (they read the workflow files) because the
 * alternative — running GitHub Actions — is not available in a unit test.
 * That is the same trade-off `tests/host-line.test.ts` makes for PUBLISH.md:
 * the doc/workflow is the artefact, so pin the artefact.
 *
 * History this pins down:
 *
 *   - `ci-green` polled `ci.yml` for 5 minutes. `ci.yml` only triggers on
 *     `push: branches: [main]`, so a tag pushed alone had no run to wait for
 *     (guaranteed timeout), and pushing `main` + tag together started the
 *     poll and the CI run simultaneously — one slow run (7m35s) blew the
 *     budget and blocked the release until someone re-ran it by hand.
 *   - Upstream's `publish-npm` cannot be used by this fork: the npm name is
 *     upstream's. `npm-publish-disabled` documents that and must stay after
 *     `release`, never before it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const release = read(".github/workflows/release.yml");
const ci = read(".github/workflows/ci.yml");
const publishDoc = read("PUBLISH.md");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

/** The `jobs:` block of a workflow, split into one string per job. */
function jobBlocks(yaml: string): Record<string, string> {
  const jobs: Record<string, string> = {};
  const start = yaml.search(/^jobs:/m);
  if (start === -1) return jobs;
  const body = yaml.slice(start);
  // A job starts at a 2-space-indented key; its body runs until the next one.
  const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
  const marks: Array<{ name: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) marks.push({ name: match[1]!, index: match.index });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : body.length;
    jobs[mark.name] = body.slice(mark.index, end);
  });
  return jobs;
}

const releaseJobs = jobBlocks(release);
const ciJobs = jobBlocks(ci);

/**
 * Strip YAML comment lines before asserting on content.
 *
 * The workflows carry long explanatory comments — including the ones that
 * document the very bugs these tests guard (e.g. a comment saying "no
 * separate `npm run build`"). Matching against raw text would make those
 * comments trip their own assertions.
 */
const code = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("release workflow: verification happens in place", () => {
  it("is triggered by tags only", () => {
    // `branches:` here would fire the publisher on every main push.
    expect(release).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:/);
    expect(release).not.toMatch(/^\s{4}branches:/m);
  });

  it("does not poll another workflow", () => {
    // The whole point of the rewrite: nothing to wait for.
    expect(code(release)).not.toContain("ci-green");
    expect(code(release)).not.toMatch(/seq 1 60/);
    expect(code(release)).not.toContain("actions/runs?head_sha");
  });

  it("builds and tests the tagged commit itself", () => {
    const verify = releaseJobs.verify;
    expect(verify).toBeDefined();
    expect(verify).toContain("npm ci");
    expect(verify).toContain("npm run build");
    expect(verify).toContain("npm test");
  });

  it("refuses a tag that disagrees with package.json", () => {
    // Checked in `verify`, i.e. before a Release or an npm version exists —
    // so the mistake costs nothing to undo.
    const verify = releaseJobs.verify!;
    expect(verify).toContain("package.json");
    expect(verify).toContain("GITHUB_REF_NAME");
  });
});

describe("release workflow: npm is a documented no-op", () => {
  it("keeps the publish job as a no-op that waits for release", () => {
    // Upstream publishes to npm; this fork cannot (the bare name belongs to
    // upstream), so the job must exist as an explicit no-op after `release`.
    expect(releaseJobs["npm-publish-disabled"]).toBeDefined();
    expect(releaseJobs["npm-publish-disabled"]).toMatch(/needs:\s*release\b/);
    expect(releaseJobs["publish-npm"]).toBeUndefined();
  });

  it("release waits on verify", () => {
    expect(releaseJobs.release).toBeDefined();
    expect(releaseJobs.release).toMatch(/needs:\s*verify\b/);
  });

  it("explains why the fork does not publish to npm", () => {
    const noop = releaseJobs["npm-publish-disabled"]!;
    expect(noop).toContain("pan17/dsh-wechat");
    expect(noop).toContain("Skipping npm publish");
    expect(publishDoc).toContain("npm-publish-disabled");
    expect(publishDoc).toContain("不发布 npm");
  });

  it("serialises releases and never cancels one midway", () => {
    expect(release).toMatch(/concurrency:/);
    expect(release).toContain("cancel-in-progress: false");
  });
});

describe("release workflow: npm cache survives a version bump", () => {
  it.each([
    ["ci.yml", () => ciJobs.build!],
    ["release.yml verify", () => releaseJobs.verify!],
  ])("%s restores the cache with a prefix fallback", (_name, block) => {
    // `npm version` rewrites package-lock.json on every release, so a cache
    // keyed strictly on hashFiles(lockfile) ALWAYS missed on the release
    // commit (one cold install took 7m01s). `restore-keys` turns a key change
    // into a partial hit.
    const body = block();
    expect(body).toContain("actions/cache@v4");
    expect(body).toContain("restore-keys:");
    expect(body).toContain("hashFiles('package-lock.json')");
  });

  it("does not use setup-node's strict cache mode", () => {
    // `cache: npm` is the option that has no fallback.
    expect(release).not.toMatch(/^\s*cache:\s*npm\s*$/m);
    expect(ci).not.toMatch(/^\s*cache:\s*npm\s*$/m);
  });
});

describe("release workflow: the fork never runs npm publish", () => {
  it("keeps prepublishOnly build+test for any manual publish", () => {
    // The fork does not publish, but if someone ever publishes manually the
    // tarball must still be the tested one.
    expect(pkg.scripts.prepublishOnly).toContain("npm run build");
    expect(pkg.scripts.prepublishOnly).toContain("npm test");
  });

  it("has no npm publish command and no npm token in the workflow", () => {
    expect(code(release)).not.toMatch(/^\s*run:\s*npm publish/m);
    expect(code(release)).not.toContain("NODE_AUTH_TOKEN");
    expect(code(release)).not.toContain("secrets.DSH_WECHAT");
  });
});

describe("release workflow: bounded jobs", () => {
  it("every job has a timeout", () => {
    // Without a timeout a hung `npm ci` occupies a runner for the default
    // 6 hours and blocks the concurrency group with it.
    for (const [name, block] of Object.entries(releaseJobs)) {
      expect(block, `${name} has no timeout-minutes`).toContain("timeout-minutes:");
    }
    for (const [name, block] of Object.entries(ciJobs)) {
      expect(block, `${name} has no timeout-minutes`).toContain("timeout-minutes:");
    }
  });
});

describe("release script", () => {
  it("is wired to npm run release", () => {
    expect(pkg.scripts.release).toBe("node scripts/release.mjs");
  });

  it("keeps push opt-in", () => {
    // PUBLISH.md requires a human confirmation before anything leaves the
    // machine, so the default path must stop after the tag.
    const script = read("scripts/release.mjs");
    expect(script).toContain('"--push"');
    expect(script).toMatch(/if \(push\)/);
  });

  it("survives npm swallowing --dry-run and --push", () => {
    // `npm run release patch --dry-run` never delivers the flag to the
    // script: npm claims it as its own config. Before this fallback existed,
    // that command performed a REAL release (version bump, commit, tag).
    // npm exports each flag as `npm_config_<name>`, which is the recovery
    // path — both spellings must therefore be honoured.
    const script = read("scripts/release.mjs");
    expect(script).toContain("npm_config_dry_run");
    expect(script).toContain("npm_config_push");
    expect(script).toMatch(/npmFlag\("dry_run"\)/);
    expect(script).toMatch(/npmFlag\("push"\)/);
  });

  it("tells maintainers to use the -- separator", () => {
    // The documented command must be the safe one, not merely a working one.
    // The unsafe spelling may still appear inside the warning that explains
    // it — but never as a bare instruction line in a shell block.
    expect(publishDoc).toContain("npm run release -- patch --dry-run");
    expect(publishDoc).toContain("npm run release -- patch --push");
    const commandLines = publishDoc
      .split("\n")
      .filter((line) => /^npm run release/.test(line.trim()));
    expect(commandLines.length).toBeGreaterThan(0);
    for (const line of commandLines) {
      expect(line, `missing "--": ${line}`).toMatch(/npm run release -- /);
    }
  });

  it("explains why the separator is required", () => {
    expect(publishDoc).toMatch(/`--` 不能省/);
  });

  it("refuses an empty [Unreleased] section", () => {
    // An empty section means empty GitHub Release notes, which the
    // changelog query would otherwise accept silently.
    const script = read("scripts/release.mjs");
    expect(script).toContain("Unreleased");
    expect(script).toContain("没有任何条目");
  });

  it("keeps both version fields in sync via npm version", () => {
    // package-lock.json carries the version twice; editing package.json by
    // hand is how the two drift apart.
    const script = read("scripts/release.mjs");
    expect(script).toContain("--no-git-tag-version");
    expect(script).toContain("--allow-same-version");
  });
});

describe("PUBLISH.md describes the pipeline that exists", () => {
  it("names the one-command release path", () => {
    expect(publishDoc).toContain("npm run release");
  });

  it("no longer tells maintainers to wait for CI after pushing a tag", () => {
    // The old instructions described a flow that could not work for a
    // standalone tag push. Mentioning `ci-green` in the "why this changed"
    // note is fine; presenting it as a pipeline step is not.
    expect(publishDoc).not.toMatch(/推 tag 后[^\n]*等 ?CI/);
    expect(publishDoc).not.toMatch(/^\s*\d+\.\s+\*\*`ci-green`\*\*/m);
  });

  it("documents the verify → release → npm-publish-disabled chain", () => {
    expect(publishDoc).toMatch(/verify → release → npm-publish-disabled/);
    // The no-publish policy must be stated where maintainers will read it.
    expect(publishDoc).toMatch(/不发布 npm/);
  });
});
