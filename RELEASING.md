# Releasing

KiroLink follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **PATCH** (`1.0.x`) — bug fixes, no behavior change for users
- **MINOR** (`1.x.0`) — new features, backward compatible
- **MAJOR** (`x.0.0`) — breaking changes

## Rules

1. **Never tag work-in-progress.** Tags are only for shippable releases.
2. **One tag = one published version.** npm rejects republishing an existing
   version, so never reuse a version number.
3. **`main` is always green** — `pnpm build` and `pnpm test` must pass before tagging.
4. **Update `CHANGELOG.md`** in the same commit that bumps the version.
5. **Commit messages** follow Conventional Commits: `feat:`, `fix:`, `chore:`,
   `docs:`, `test:`, `refactor:`.
6. **Release notes come from `CHANGELOG.md`.** GitHub releases and npm tags
   should describe the same shipped content.

## Maintainer scripts

```bash
pnpm release:check
```

Runs `typecheck`, `test`, `build`, and `npm pack --dry-run`.

```bash
pnpm release:prepare -- patch
pnpm release:prepare -- minor
pnpm release:prepare -- major
pnpm release:prepare -- 2.1.0
```

Runs release checks, bumps `package.json`, and moves the current
`[Unreleased]` changelog section into a dated release entry.

```bash
pnpm release:notes -- 2.1.0
```

Prints the exact release-notes body for a shipped version from `CHANGELOG.md`.

## Release steps

```bash
# 1. Make sure main is clean and green
git checkout main && git pull
pnpm install
pnpm release:check

# 2. Prepare version metadata
pnpm release:prepare -- patch   # or: minor | major | x.y.z

# 3. Review and commit
git add package.json CHANGELOG.md
git commit -m "chore: release vX.Y.Z"

# 4. Tag and push
git tag vX.Y.Z
git push --follow-tags
```

The publish workflow runs on tag push (`v*`): it runs checks, publishes to
npm with provenance, and creates a GitHub Release whose notes are rendered from
`CHANGELOG.md`. Set the `NPM_TOKEN` repo secret first.

## If a release goes wrong

- **Bad tag, not yet published:** delete it before the workflow finishes.
  ```bash
  git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
  ```
- **Already published to npm:** do NOT try to reuse the version. Fix forward
  with a new PATCH release. npm unpublish is restricted and discouraged.
