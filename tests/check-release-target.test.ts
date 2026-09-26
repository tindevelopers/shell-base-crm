import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import {
  checkReleaseTargets,
  incVersion,
  npmView,
  npmViewArgs,
  workspaceVersionFromRepo,
} from "../scripts/check-release-target.mjs";

/**
 * Negative self-proofs for the release-target sentinel
 * (scripts/check-release-target.mjs), ported byte-identical from
 * shell-base-admin. Adapted for shared-client-care-hub (schema-crm,
 * domain-contacts, domain-campaigns, ui-crm, schema-support,
 * domain-pipeline, domain-support): every scenario below uses THIS hub's
 * own packages and its own committed release-targets.json, never
 * shell-base-admin's package names or publish history.
 *
 * A sentinel that has never been shown to fail proves nothing, so each of
 * the four fail-closed conditions gets its own failing fixture, plus the
 * domain-support-hazard mechanism (simulated — this hub records no
 * knownDrift entry today, see release-targets.json's description field for
 * why), and a positive leg that proves the recorded config alone never
 * fails.
 *
 * Every scenario is simulated against the committed registry snapshot
 * (recorded in release-targets.json) — never against the live registry,
 * and never by publishing or moving a tag.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type RegistryState = {
  versions: string[];
  distTags: Record<string, string>;
  time: Record<string, string>;
};

type Config = ReturnType<typeof committedConfig>;

function committedConfig(): Record<string, any> {
  return JSON.parse(
    readFileSync(join(repoRoot, "release-targets.json"), "utf8"),
  );
}

/** A registry reader that replays the committed snapshot for a package. */
function snapshotReader(config: Config) {
  return (pkg: string): RegistryState | null => {
    const snap = config.snapshot.packages[pkg];
    if (!snap) return null;
    return {
      versions: [...snap.versions],
      distTags: { ...snap.distTags },
      time: { ...snap.publishTimes },
    };
  };
}

/**
 * Default workspace-version reader: the REAL on-disk packages/<dir>/package.json
 * versions (the same reader check-release-target.mjs's own CLI entry point
 * uses), not a hardcoded map. This means the "positive leg" test below keeps
 * working as the hub's packages evolve, instead of needing its own version
 * map kept in sync by hand.
 */
function baseDeps(config: Config, overrides: Record<string, string> = {}) {
  const readReal = workspaceVersionFromRepo(repoRoot);
  return {
    fetchRegistry: snapshotReader(config),
    workspaceVersion: (pkg: string) => overrides[pkg] ?? readReal(pkg),
  };
}

function run(config: Config, deps = baseDeps(config)) {
  return checkReleaseTargets(config, deps);
}

/**
 * A hypothetical next ui-crm minor after the published 1.0.0, planted into
 * an otherwise-committed config for the fail-closed proofs below (this
 * hub's one real pin, domain-support@5.0.0, stays in place alongside it and
 * is unaffected — the stand-in exercises a second, independent package).
 */
const STAND_IN_PIN = {
  package: "@tindevelopers/ui-crm",
  version: "1.1.0",
  bump: "minor",
  milestone: "stand-in",
  conditional: true,
  status: "planned",
};
function configWithStandInPin(): Config {
  const config = committedConfig();
  config.pins.push({ ...STAND_IN_PIN });
  return config;
}

describe("release-target sentinel — committed configuration (shared-client-care-hub)", () => {
  it("has no open pins: every release is published, recorded and retired", () => {
    const config = committedConfig();
    expect(config.pins).toEqual([]);
    const pipeline = config.snapshot.packages["@tindevelopers/domain-pipeline"];
    expect(pipeline.missionPublishes.map((m: any) => m.version)).toEqual(["1.0.0", "1.0.1"]);
    expect(pipeline.missionPublishes[0].defective).toMatch(/DO NOT USE/);
    expect(config.governance.pinsLifecycleClosed).toBe(true);
    const snap = config.snapshot.packages["@tindevelopers/domain-support"];
    expect(snap.versions).toContain("5.0.0");
    expect(snap.distTags.next).toBe("5.0.0");
    expect(snap.missionPublishes.map((m: any) => m.version)).toEqual(["5.0.0"]);
  });

  it("describes only this hub's packages — no knownDrift or pins carried over from another hub", () => {
    const config = committedConfig();
    // The shared-integration-hub port once copied shell-base-admin's
    // domain-support knownDrift entry verbatim, and its unrelated hazard
    // condition blocked an adapter-kit release there. This hub's config
    // must not repeat that: no knownDrift entry unless the sentinel
    // actually requires one to let the 5.0.0 pin through (it doesn't —
    // see the passing leg below and the hazard self-proofs).
    expect(config.knownDrift).toEqual([]);
    const hubPackages = Object.keys(config.snapshot.packages);
    for (const pin of config.pins) expect(hubPackages).toContain(pin.package);
  });

  it("passes against the committed snapshot with the real on-disk workspace versions (positive leg)", () => {
    const result = run(committedConfig());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("release-target sentinel — negative self-proofs (fail closed)", () => {
  it("condition 1: fails when a pinned target is no longer free", () => {
    const config = configWithStandInPin();
    // Someone published the planned ui-crm 1.1.0 out-of-band: it is now on
    // the registry while still planned.
    config.snapshot.packages["@tindevelopers/ui-crm"].versions.push("1.1.0");
    const result = run(config);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "condition-1-target-not-free",
    );
    expect(failure).toBeDefined();
    expect(failure.package).toBe("@tindevelopers/ui-crm");
    expect(failure.message).toContain("1.1.0");
  });

  it("condition 1: fails on the hub's own real pin if domain-support@5.0.0 were published without retiring the pin", () => {
    const config = committedConfig();
    // The exact blocking shape a publish creates WITHOUT the same-commit pin
    // retirement (PUBLISH.md's pin lifecycle rule): 5.0.0 IS on the registry
    // (committed snapshot) but its pin is put back in `pins`.
    config.pins.push({
      package: "@tindevelopers/domain-support",
      version: "5.0.0",
      bump: "major",
      milestone: "shared-client-care-hub-first-publish",
    });
    const result = run(config);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) =>
        f.condition === "condition-1-target-not-free" &&
        f.package === "@tindevelopers/domain-support",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("5.0.0");
  });

  it("condition 2: fails when the target is the wrong semver step from an unreconciled workspace", () => {
    const config = configWithStandInPin();
    // A stale ui-crm workspace against the planted planned 1.1.0 target: a
    // minor changeset from 0.9.0 does not compute 1.1.0, so the pinned
    // 1.1.0 is the wrong step and the sentinel must fail closed.
    const deps = baseDeps(config, { "@tindevelopers/ui-crm": "0.9.0" });
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "condition-2-wrong-semver-step",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("0.9.0");
    expect(failure.message).toContain("1.1.0");
  });

  it("condition 2: PASSES in the ready-to-publish state (workspace === unpublished pin)", () => {
    const config = configWithStandInPin();
    // The exact state release.yml's sentinel step occupies AFTER
    // `changeset version` and BEFORE `npm publish`: the workspace has been
    // bumped to the next unpublished pinned target, which is still
    // unpublished — the second sanctioned green state of condition 2.
    const deps = baseDeps(config, { "@tindevelopers/ui-crm": "1.1.0" });
    const result = run(config, deps);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("condition 2: fails when the workspace was bumped PAST an unpublished pin (one step above)", () => {
    const config = configWithStandInPin();
    // Workspace 1.1.1 sits one step ABOVE the unpublished pinned ui-crm
    // 1.1.0 — a planning error. Condition 2 fails closed: 1.1.1 is neither
    // the pin itself nor one correct step below it.
    const deps = baseDeps(config, { "@tindevelopers/ui-crm": "1.1.1" });
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "condition-2-wrong-semver-step",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("1.1.1");
    expect(failure.message).toContain("1.1.0");
  });

  it("condition 2 republish guard: workspace === pin with the version ALREADY on the registry fails", () => {
    const config = configWithStandInPin();
    config.snapshot.packages["@tindevelopers/ui-crm"].versions.push("1.1.0");
    const deps = baseDeps(config, { "@tindevelopers/ui-crm": "1.1.0" });
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "condition-1-target-not-free",
    );
    expect(failure).toBeDefined();
    expect(failure.package).toBe("@tindevelopers/ui-crm");
    expect(failure.message).toContain("1.1.0");
  });

  it("condition 3: fails when latest has moved past the pinned target", () => {
    const config = configWithStandInPin();
    const uiCrm = config.snapshot.packages["@tindevelopers/ui-crm"];
    uiCrm.versions.push("1.2.0");
    uiCrm.publishTimes["1.2.0"] = "2026-09-27T12:00:00Z";
    uiCrm.distTags.latest = "1.2.0";
    const result = run(config);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) =>
        f.condition === "condition-3-tag-moved-past-target" &&
        f.message.includes("latest") &&
        f.message.includes("1.2.0"),
    );
    expect(failure).toBeDefined();
  });

  it("condition 3: fails when next has moved past the pinned target", () => {
    const config = configWithStandInPin();
    const uiCrm = config.snapshot.packages["@tindevelopers/ui-crm"];
    uiCrm.versions.push("1.1.1");
    uiCrm.publishTimes["1.1.1"] = "2026-09-27T12:00:00Z";
    uiCrm.distTags.next = "1.1.1";
    const result = run(config);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) =>
        f.condition === "condition-3-tag-moved-past-target" &&
        f.message.includes("next") &&
        f.message.includes("1.1.1"),
    );
    expect(failure).toBeDefined();
  });

  it("condition 4: fails on an unexplained new registry version", () => {
    const config = committedConfig();
    // An out-of-band 5.0.1 appears on the LIVE registry for domain-support:
    // not a pin, not in the committed snapshot — unexplained divergence.
    const deps = baseDeps(config);
    const plainFetch = deps.fetchRegistry;
    deps.fetchRegistry = (pkg: string) => {
      const live = plainFetch(pkg);
      if (pkg === "@tindevelopers/domain-support" && live) {
        live.versions.push("5.0.1");
        live.time["5.0.1"] = "2026-09-27T00:00:00Z";
      }
      return live;
    };
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "condition-4-unexplained-divergence",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("5.0.1");
  });

  it("condition 4: fails on an unexplained dist-tag change", () => {
    const config = committedConfig();
    // latest silently moved from 4.0.0 to 1.0.0 on the LIVE registry — not a
    // pinned target, so the change is unexplained (and it would be a
    // backwards move).
    const deps = baseDeps(config);
    const plainFetch = deps.fetchRegistry;
    deps.fetchRegistry = (pkg: string) => {
      const live = plainFetch(pkg);
      if (pkg === "@tindevelopers/domain-support" && live) {
        live.distTags.latest = "1.0.0";
      }
      return live;
    };
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "condition-4-unexplained-divergence",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("latest");
  });

  it("never-publish: fails if a pin names a never-publish version", () => {
    const config = committedConfig();
    // Self-contained: this hub's neverPublish list is empty today, so the
    // banned entry is planted in the same test as the pin that names it.
    config.neverPublish.push({
      package: "@tindevelopers/domain-support",
      version: "4.0.0",
      reason: "forbidden-test",
    });
    config.pins.push({
      package: "@tindevelopers/domain-support",
      version: "4.0.0",
      bump: "patch",
      milestone: "forbidden-test",
    });
    const result = run(config);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "never-publish",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("4.0.0");
  });

  it("domain-support hazard: fails on a family pin at or below the registry high-water mark", () => {
    const config = committedConfig();
    // Self-contained simulated drift — this hub's real config carries no
    // knownDrift entry (not needed for the real 5.0.0 pin; see the
    // "committed configuration" describe block above). This proves the
    // mechanism itself still fails closed if a knownDrift entry is ever
    // added and a family pin lands at or below the recorded high-water mark.
    config.knownDrift.push({
      package: "@tindevelopers/domain-support",
      status: "KNOWN",
      registryLatest: "4.0.0",
      familyTargetAuthorized: true,
    });
    config.pins.push({
      package: "@tindevelopers/domain-support",
      version: "3.9.0",
      bump: "patch",
      milestone: "forbidden-test",
    });
    const deps = baseDeps(config, { "@tindevelopers/domain-support": "3.9.0" });
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "hazard-domain-support",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("3.9.0");
  });

  it("domain-support hazard: an unauthorized family pin fails until explicitly granted", () => {
    const config = committedConfig();
    config.knownDrift.push({
      package: "@tindevelopers/domain-support",
      status: "KNOWN",
      registryLatest: "4.0.0",
      familyTargetAuthorized: false,
    });
    config.pins.push({
      package: "@tindevelopers/domain-support",
      version: "5.0.1",
      bump: "patch",
      milestone: "forbidden-test",
    });
    const deps = baseDeps(config, { "@tindevelopers/domain-support": "5.0.1" });
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    const failure = result.failures.find(
      (f: any) => f.condition === "hazard-domain-support",
    );
    expect(failure).toBeDefined();
    expect(failure.message).toContain("5.0.1");
    expect(failure.message).toMatch(/NOT authorized/);
  });

  it("domain-support hazard: once an authorization IS granted, exactly that forward pin passes", () => {
    const config = committedConfig();
    config.knownDrift.push({
      package: "@tindevelopers/domain-support",
      status: "KNOWN",
      registryLatest: "4.0.0",
      familyTargetAuthorized: true,
    });
    config.pins.push({
      package: "@tindevelopers/domain-support",
      version: "5.0.1",
      bump: "patch",
      milestone: "authorized-test",
    });
    const deps = baseDeps(config, { "@tindevelopers/domain-support": "5.0.1" });
    const result = run(config, deps);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("release-target sentinel — read-only registry access", () => {
  it("only ever runs a read-only npm view with exactly the sanctioned fields", () => {
    expect(npmViewArgs("@tindevelopers/domain-support")).toEqual([
      "view",
      "@tindevelopers/domain-support@>=0.0.0",
      "versions",
      "dist-tags",
      "time",
      "--json",
    ]);
  });

  it("fails closed when the registry is unreachable", () => {
    const config = committedConfig();
    const deps = {
      fetchRegistry: () => null,
      workspaceVersion: () => "1.0.0",
    };
    const result = run(config, deps);
    expect(result.ok).toBe(false);
    expect(
      result.failures.some((f: any) =>
        f.condition.includes("registry-unreachable"),
      ),
    ).toBe(true);
  });
});

describe("npmView — a 404 means never-published, not unreachable", () => {
  afterEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("returns the empty registry state on an npm view E404 (package never published)", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stdout: "",
      stderr:
        "npm error code E404\n" +
        "npm error 404 Not Found - GET https://registry.npmjs.org/@tindevelopers%2fnever-published - Not found",
    } as any);
    expect(npmView("@tindevelopers/never-published")).toEqual({
      versions: [],
      distTags: {},
      time: {},
    });
  });

  it("still fails closed (returns null) on a genuine non-404 npm view failure (e.g. network/auth error)", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stdout: "",
      stderr: "npm error code ENETUNREACH\nnpm error network request failed",
    } as any);
    expect(npmView("@tindevelopers/domain-support")).toBeNull();
  });

  it("still fails closed (returns null) when the npm process itself cannot be spawned", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      signal: null,
      error: new Error("spawn npm ENOENT"),
      stdout: "",
      stderr: "",
    } as any);
    expect(npmView("@tindevelopers/domain-support")).toBeNull();
  });

  it("planning state: a pin for a never-published package passes once npm view reports the empty (E404) registry state", () => {
    const config = committedConfig();
    config.pins.push({
      package: "@tindevelopers/never-published",
      version: "1.1.0",
      bump: "minor",
      milestone: "new-package-test",
    });
    const deps = baseDeps(config, {
      "@tindevelopers/never-published": "1.0.0",
    });
    const plainFetch = deps.fetchRegistry;
    deps.fetchRegistry = (pkg: string) =>
      pkg === "@tindevelopers/never-published"
        ? { versions: [], distTags: {}, time: {} } // what npmView now returns for E404
        : plainFetch(pkg);
    const result = run(config, deps);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("incVersion (semver step arithmetic)", () => {
  it("computes patch, minor and major steps", () => {
    expect(incVersion("1.1.1", "patch")).toBe("1.1.2");
    expect(incVersion("1.2.0", "minor")).toBe("1.3.0");
    expect(incVersion("1.1.3", "major")).toBe("2.0.0");
    expect(incVersion("1.0.0", "minor")).toBe("1.1.0");
  });
});
