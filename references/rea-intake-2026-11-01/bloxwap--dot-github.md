# bloxwap/.github

- Source: https://github.com/bloxwap/.github @ 499059836564dd5cbc0a82d94747840528a0a62a (2026-10-27)
- Licence: none found. There is no LICENSE file, no package.json, and no licence notice in README.md, profile/README.md, renovate-config.json or the workflow files. Treat it as all rights reserved: ideas only. Code from it may not be copied into an Apache-2.0 or MIT project.

## What it does

This is the bloxwap organisation's special `.github` repository. It holds the org profile page (`profile/README.md`, a light/dark wordmark and a tagline), a README template for the org's package repos, a shared Renovate preset, and three GitHub Actions workflows. Two of the workflows are reusable (`workflow_call`) security scanners that the other bloxwap repos call by commit SHA: a full nightly/release scan and a fast pull-request gate. The third workflow is this repo's own nightly caller of the scanner. `jobs/head-of-growth.md` contains only a heading.

## How it is built

- `README.md`: changelog for the reusable workflows (v1.0.2, v1.1.0).
- `profile/README.md` + `profile/assets/*.svg`: org profile, using a `<picture>` with `prefers-color-scheme` sources to switch between a black and a white wordmark.
- `README_TEMPLATE.md` (111 lines): fill-in template for package READMEs (centred title, npm/codecov/bundle-size badges, Features, Installation, and style notes such as "use commas, periods ... instead of em-dashes").
- `renovate-config.json`: shared preset that repos opt into with `"extends": ["local>bloxwap/.github:renovate-config"]` (bloxwap.github.io and screensaver both do). It enables osv.dev vulnerability alerts, a dependency dashboard, weekly lockfile maintenance, grouped minor/patch updates on Monday mornings, PR rate limits and SHA digest pinning for GitHub Actions.
- `.github/workflows/security-scan.yml` (647 lines, reusable): inputs for `profile` (nightly or release), `deps`, `fail-cvss` (default 7.0), `enforce`, `secrets-scan`/`secrets-mode`/`secrets-days`, `iac`, `workflow-lint`, `semgrep`, `upload-sarif`, `notify-slack`. Jobs: `scan` (release profile, one job), `secrets` (gitleaks), `iac` (trivy config), `workflow-lint` (actionlint + zizmor), `semgrep` (report-only, via uv) and `gate` (fails and posts to Slack).
- `.github/workflows/security-pr-gate.yml` (170 lines, reusable): two independent jobs that only look at what the PR or push changed: lockfiles changed in the diff (osv-scanner) and commits in the range (gitleaks).
- `.github/workflows/security-nightly.yml`: this repo's caller; Mon–Sat incremental and Sunday full-history secret scans, plus a PR trigger when scan config or ignore files change.
- All runners are self-hosted macOS ARM64 ("Mac minis"); fork PRs are skipped by an `if:` guard.
- No tests, no llms.txt, sitemap, evidence folder or hig-drift.json.

## Reusable techniques worth learning

1. **Org-wide reusable security workflow pinned by SHA** (`.github/workflows/security-scan.yml`, callers in other repos). One public repo holds the scanner logic behind `workflow_call` inputs; every repo calls it as `uses: bloxwap/.github/.github/workflows/security-scan.yml@<sha> # v1.1.0`. Profiles (nightly vs release) change the job shape: nightly fans out to parallel jobs, release runs one job so it uses one runner slot and can sit in a deploy's `needs:`. Worth learning because it keeps one copy of security policy and lets each repo upgrade deliberately.
2. **"Fixable and severe" dependency gate** (`security-pr-gate.yml`, `security-scan.yml`). osv-scanner output is post-processed with jq into two lists: `fail` (CVSS at or above the floor AND a fixed version newer than the installed one exists) and `report_only` (everything else). Only `fail` breaks the build; both go to the job summary. This avoids blocking work on vulnerabilities nobody can fix yet.
3. **Scan only the diff on PRs** (`security-pr-gate.yml`). The gate diffs merge-base..HEAD, keeps only lockfile paths matching a regex of known lockfile names, and scans just those; gitleaks runs over just the PR's commits. Fast PR checks, with the full scan left to nightly.
4. **Checksum-pinned tool downloads with cache and backoff** (`fetch()` shell function in both reusable workflows). Each binary has a pinned URL and SHA-256; a cached copy is re-verified each run, a bad cache is deleted, downloads go to a temp file, are verified, then moved into place atomically, with four attempts and 5/15/45 s backoff. A general pattern for any script that installs tools from the network.
5. **API-first with a one-off offline fallback** (`security-pr-gate.yml`). If the osv.dev API is unreachable (exit code > 1), the scan reruns once with a downloaded offline database for that run only, and fails closed if both fail.
6. **Shared Renovate preset** (`renovate-config.json`). One preset sets schedules, grouping, OSV alerts and Actions digest pinning; repos extend it with a two-line `renovate.json`.
7. **Report-only lane that never gates** (semgrep job, README v1.1.0). New scanners are added with `continue-on-error`, kept out of the gate's `needs`, and only notify on High findings, so adding a tool cannot break existing pipelines.

## Fit with trillion-workshop tools

None directly. These are repository CI and dependency-maintenance conventions, and no tool under `tools/` scans dependencies, runs CI, or manages Renovate (the workshop root has no `.github/workflows` either). `tools-from-github` reads licences and activity of repos it lists but does not judge their dependency risk, and adding an osv.dev lookup there would be a new feature with network access, not a small change. The ideas (fixable-and-severe gate, SHA-verified downloads) are better taken as workshop repo hygiene than as tool changes.

## Cautions

- No licence: do not copy the workflow YAML, the jq gate program or the `fetch()` function. Write any equivalent independently.
- Everything assumes self-hosted macOS ARM64 runners, darwin_arm64 binaries and `shasum`; it would not run as-is on Linux runners.
- Slack notifications depend on a secret webhook the callers pass in.
- Pinned scanner versions and checksums will age; the repo relies on its own Renovate preset to keep them current.
