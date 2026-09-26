/**
 * Packed publishability for workspace-protocol dependencies.
 *
 * Source `workspace:` ranges are allowed in this hub; what must NOT happen is
 * shipping one. These tests enforce the ruling two ways:
 *
 * - The validator CLI rejects a `workspace:` specifier that no workspace
 *   package can rewrite to a concrete version (fixture-driven accept/reject).
 * - `pnpm pack` on the real domain-contacts package is proven to rewrite the
 *   `workspace:^` `@tindevelopers/schema-crm` dependency to a concrete caret
 *   range of the workspace version, and no packed manifest field retains a
 *   `workspace:` specifier.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const validator = resolve(root, "scripts/validate-packages.mjs");
const packagesDir = resolve(root, "packages");

/** Temp roots (system tmpdir only), removed after each test. */
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runValidator(dir: string): { exitCode: number; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [validator, dir], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, out: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const builtFiles = {
  LICENSE: "MIT\n",
  "dist/index.js": "export {};\n",
  "dist/index.d.ts": "export {};\n",
};

function fixturePackage(dir: string, name: string, manifest: Record<string, unknown>): void {
  const pkgRoot = join(dir, name);
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, contents] of Object.entries(builtFiles)) {
    const abs = join(pkgRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf-8");
  }
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@fixture/pkg",
    license: "MIT",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    },
    ...overrides,
  };
}

describe("validate-packages CLI: workspace dependency publishability (fixtures)", () => {
  it("accepts a workspace specifier rewritable to a concrete sibling version", () => {
    const dir = tempDir("ws-ok-");
    fixturePackage(dir, "dep", {
      name: "@fixture/dep",
      version: "1.1.0",
      license: "MIT",
      exports: validManifest().exports,
    });
    fixturePackage(
      dir,
      "pkg",
      validManifest({ dependencies: { "@fixture/dep": "workspace:^" } }),
    );
    const { exitCode, out } = runValidator(dir);
    expect(out).toContain("valid");
    expect(exitCode).toBe(0);
  });

  it("rejects a workspace specifier no workspace package can rewrite", () => {
    const dir = tempDir("ws-bad-");
    fixturePackage(
      dir,
      "pkg",
      validManifest({ dependencies: { "@fixture/ghost": "workspace:*" } }),
    );
    const { exitCode, out } = runValidator(dir);
    expect(exitCode).toBe(1);
    expect(out).toContain("cannot be rewritten for publish");
  });
});

describe("pnpm pack rewrites workspace specifiers to concrete versions", () => {
  it(
    "domain-contacts tarball depends on the concrete workspace schema-crm version",
    () => {
      const schemaCrm = JSON.parse(
        readFileSync(join(packagesDir, "schema-crm/package.json"), "utf8"),
      ) as { version: string };
      const source = JSON.parse(
        readFileSync(join(packagesDir, "domain-contacts/package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      // Precondition: the source dependency uses the workspace protocol.
      expect(source.dependencies["@tindevelopers/schema-crm"]).toMatch(/^workspace:/);

      const dest = tempDir("pack-domain-contacts-");
      execFileSync("pnpm", ["pack", "--pack-destination", dest], {
        cwd: join(packagesDir, "domain-contacts"),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tarball = readdirSync(dest).find((f) => f.endsWith(".tgz"));
      expect(tarball).toBeTruthy();

      const packed = JSON.parse(
        execFileSync("tar", ["-xOf", join(dest, tarball as string), "package/package.json"], {
          encoding: "utf-8",
        }),
      ) as Record<string, Record<string, string> | undefined>;

      // workspace:^ rewrites to a concrete caret range of the workspace
      // version, so a Changesets RC (e.g. 1.1.0-rc.0) packs compatibly.
      expect(packed.dependencies?.["@tindevelopers/schema-crm"]).toBe(
        `^${schemaCrm.version}`,
      );

      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const specifier of Object.values(packed[field] ?? {})) {
          expect(String(specifier).startsWith("workspace:")).toBe(false);
        }
      }
    },
    120_000,
  );
});

describe("release.yml ships what pnpm packed", () => {
  // domain-pipeline@1.0.0 went out with `"@tindevelopers/schema-crm":
  // "workspace:^"` because release.yml packed and published with npm, which
  // never rewrites workspace specifiers. The workflow must pack with pnpm,
  // refuse a packed manifest that still says workspace, and publish that
  // exact tarball.
  // Comments are dropped so the explanation of the bug doesn't match itself.
  const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("packs with pnpm, never npm", () => {
    expect(workflow).toMatch(/\bpnpm pack\b/);
    expect(workflow).not.toMatch(/\bnpm pack\b/);
  });

  it("checks packed manifests for workspace specifiers before publishing", () => {
    const check = workflow.indexOf("still contains a workspace: specifier");
    const publish = workflow.indexOf("npm publish");
    expect(check).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(check);
  });

  it("publishes tarballs, not package directories", () => {
    for (const line of workflow.split("\n").filter((l) => /\bnpm publish\b/.test(l))) {
      expect(line).toMatch(/npm publish "\$tarball"/);
    }
  });
});
