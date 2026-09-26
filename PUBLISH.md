# Manual Publish & Deploy Runbook

`shared-client-care-hub` publishes `@tindevelopers/*` packages to GitHub
Packages: `schema-crm`, `domain-contacts`, `domain-campaigns`, `ui-crm`,
`schema-support`, `domain-pipeline`, `domain-support`. This document lists
every step that requires manual authorization or credentials the automated
agent does not have.

> **Auth gotchas:**
> - `npm publish` has no `--auth-token` flag — pass the token as a registry-scoped config key: `--//npm.pkg.github.com/:_authToken=<TOKEN>`.
> - Use a **Personal Access Token** (`ghp_…` or `github_pat_…`), not the `gho_…` OAuth token from `gh auth token` (the npm registry rejects OAuth tokens).
> - pnpm/npm do not expand `${GH_TOKEN}` inside a committed project `.npmrc`; rely on the explicit flag or a user-level `~/.npmrc`.

## 0. Release-target sentinel — run immediately before EVERY publish

`release-targets.json` is the committed single source of truth pinning
`{package, intended version, milestone}` for every planned publish, plus the
registry snapshot the check compares against. The sentinel
(`scripts/check-release-target.mjs`) is strictly read-only
(`npm view <pkg> versions dist-tags time --json`) and fails closed if:

1. a pinned target is no longer free (already on the registry);
2. a pinned target is not in one of its exactly TWO green states —
   **planning** (the target is the exact semver step from the current
   workspace version) or **ready-to-publish** (the workspace version EQUALS
   the pinned target and it is still unpublished — the state this sentinel
   step occupies in `release.yml`, after `changeset version` and before
   `npm publish`);
3. `latest` or `next` has moved past a pinned target;
4. the registry version list or dist-tags differ from the committed
   snapshot in any unexplained way (out-of-band publishes are EXPECTED and
   land here);
5. (the domain-support hazard) any pinned domain-support target sits at or
   below the registry's recorded high-water mark, or a family pin exists
   while a `knownDrift` record marks the family target unauthorized.

```bash
node scripts/check-release-target.mjs
```

This hub's `release-targets.json` has no open pins today
(`governance.pinsLifecycleClosed: true`). Its first release,
**`@tindevelopers/domain-support@5.0.0`** (owner-authorized 2026-09-26), was
published to `next` on 2026-09-26 by `release.yml` run 36255059090, and its
pin is retired with a `missionPublishes` row. `latest` stays at `4.0.0` until
the owner authorizes a promotion. `3.0.0` and `4.0.0` were published from
`shell-base-admin` before this hub owned the package; both are immutable and
must never be republished. `neverPublish` and `knownDrift` are both empty, and
the config deliberately does **not** carry over another hub's `knownDrift`
entry (see the note below). The next publish adds its pin and sets
`pinsLifecycleClosed` back to `false` in its release PR.

**ON SENTINEL FAILURE: STOP and return to the orchestrator.** Do not pick a
different version, do not retry with a bump, do not move a dist-tag to make
room, and do not edit `release-targets.json` to make the check pass.
Out-of-band publishes are expected; re-pinning is the orchestrator's job with
the user, never a worker's. The sentinel also runs in `ci.yml` on every PR
and push to `main`, and again inside `release.yml` immediately before the
publish step.

> **Why no `knownDrift` entry for `domain-support`:** the sentinel's
> domain-support hazard only fires when a `knownDrift` entry exists for the
> package (`scripts/check-release-target.mjs`, the `drift = ... find(...)`
> block). This hub's workspace (5.0.0) is *ahead* of the registry (4.0.0) —
> the ordinary "about to publish the next version" state, not the drift
> scenario the hazard exists for (registry ahead of workspace). Adding a
> `knownDrift` entry anyway would be pure copy-paste risk: a stale
> `familyTargetAuthorized: false` copied from another hub's history once
> blocked an unrelated release in `shared-integration-hub`. Add a
> `knownDrift` entry here only if a real registry-ahead-of-workspace drift is
> ever discovered for one of this hub's packages.

**Pin lifecycle — every mission publish retires its pin in the same evidence
commit.** The `pins` array holds PLANNED publishes only. Immediately after a
mission publish is registry-verified, the publishing worker, in the SAME
commit as the publish evidence:

1. **Removes** the consumed pin from `pins` (a consumed pin left in place
   makes the sentinel fail condition 1 on our own completed publish).
2. **Records the version in the committed snapshot truthfully**: adds it to
   `versions`, adds its publish time to `publishTimes`, and sets the dist-tag
   state the publish actually produced.
3. **Adds a `missionPublishes` provenance row** to the package's snapshot
   entry: version, publish time, mechanism (CI run id, PR, merge commit,
   tarball sha256, dist-tag transition).

## 1. Refresh GitHub auth to get `write:packages`

```bash
gh auth refresh --scopes "write:packages,repo,read:org,read:packages,workflow"
gh auth status | grep "Token scopes"
```

Or use a fine-grained Personal Access Token (PAT) with at least `repo`
(full), `write:packages`, `admin:org` (if publishing to an org):

```bash
export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**CI/release automation needs its own credential.** `ci.yml` and
`release.yml` both authenticate with the `NODE_AUTH_TOKEN` repository (or
organization) secret — a GitHub Packages PAT with `read:packages` and
`write:packages`. The workflow-level `GITHUB_TOKEN` cannot read or write
private `@tindevelopers/*` packages. **Until `NODE_AUTH_TOKEN` is added to
this repository's (or org's) secrets, `ci.yml`'s dependency install and
`release.yml`'s publish will fail with `ERR_PNPM_FETCH_401` / `403`.** Until
then, a publish must be done manually: run the sentinel locally
(`node scripts/check-release-target.mjs`) with your own authenticated
`~/.npmrc`, confirm it passes, then publish by hand per section 2.

## 2. Build and publish

`select-publishable-packages.mjs` picks every non-private package whose
version is not on the registry, and the sentinel only gates pinned ones. So a
package whose first release the owner has not authorized stays
`"private": true` (today: `schema-support`, `domain-pipeline`). Its release
PR removes the flag and adds the pin together.

```bash
pnpm install --frozen-lockfile
pnpm build
```

Then, package by package, in dependency order (verify with
`node scripts/select-publishable-packages.mjs`):

```bash
cd packages/<pkg>
npm publish --tag next --access restricted \
  --registry=https://npm.pkg.github.com \
  --//npm.pkg.github.com/:_authToken="$GH_TOKEN"
cd ../..
```

Releases publish with dist-tag `next` only, and only the packages whose
version actually changed — there is no changesets `fixed` group, so each
`@tindevelopers/*` package versions and releases independently.

`release.yml` automates this on a green `main` CI run or a manually created
GitHub release: it selects only unpublished workspace versions
(`scripts/select-publishable-packages.mjs`), packs and publishes them in
dependency order with `--tag next --access restricted`, running the sentinel
immediately before the publish step.

## 3. Promote a version from `next` to `latest`

A separate, deliberate act — a dist-tag MOVE, never a republish (published
versions are immutable):

```bash
# Guards only — verifies the decision, mutates nothing:
node scripts/promote.mjs domain-support 5.0.0 --dry-run

# Actually move the tag:
node scripts/promote.mjs domain-support 5.0.0
```

Both guards run BEFORE any `npm dist-tag add`:

1. **Target-version guard** — the version must already exist on the
   registry. A version that was never published is refused.
2. **Monotonicity guard** — the version must be strictly semver-greater than
   the package's current `latest`. A lower-or-equal move is refused, so
   `latest` can never go backward.

## 4. Retire a package or version (GitHub Packages cannot deprecate)

**GitHub Packages has no working deprecation.** Do not use `npm deprecate`:

1. It fails with `400 ... unmarshalling packument failed: version.ID cannot
   be empty` — GitHub returns every version with `"_id": ""` and rejects
   those ids when npm uploads the metadata back.
2. Filling the ids in gets past that error, and GitHub then rejects the
   upload with `400 ... Packument Attachments required` — the endpoint
   accepts only a full publish with a tarball, and re-uploading tarballs of
   published versions would break immutability.
3. `npm unpublish` is also refused: "Package deletion from the command line
   is disabled in GitHub Package Registry".

What to do instead:

- **A bad version:** publish a strictly higher corrective patch and move
  `latest` to it (section 3). Pin consumers to the patch. Record the bad
  version in `release-targets.json`'s `neverPublish` list.
- **A whole package that is no longer needed:** confirm nothing uses it
  (every branch of every hub and of `konnect-caas-base`), confirm with the
  product owner it is not a planned roadmap package, then delete it in the
  GitHub web interface: **tindevelopers → Packages → the package → Package
  settings → Delete this package**. A deleted package can be restored for 30
  days.

## Rollback

- Never overwrite or republish an already-published version — published
  versions are immutable, and a failed publish is not recoverable at the
  same version.
- Remedy: publish a strictly-higher corrective patch and move `latest` to it
  (section 3). GitHub Packages cannot mark the bad version deprecated
  (section 4).

## What requires this runbook

- ⚠️ Publishing to GitHub Packages (needs `write:packages` token scope)
- ⚠️ Adding the `NODE_AUTH_TOKEN` repository/org secret CI and release
  automation depend on (see section 1)
- ⚠️ Deleting a retired package or version in the GitHub web interface
  (section 4)
