# PR Radar

A Paseo plugin that turns pull requests linked to active workspaces into a viewer-aware delivery queue.

PR Radar combines Paseo workspace and agent state with pull request checks, review status, mergeability, and the current GitHub user's relationship to each pull request. It answers which deliverables need you, which are already being handled, and which are waiting elsewhere.

## What it shows

- Needs you: authored blockers and review requests whose checks have completed.
- Being handled: actionable work with an active Paseo agent.
- Waiting externally: running checks, pending reviews, repository requirements, and external-author work.
- Ready: authored pull requests that are mergeable with settled checks and reviews.
- Viewer labels: `YOURS`, `REVIEW`, and `EXTERNAL`.
- Contextual actions: ask an existing agent or start one in the linked workspace.

Paseo supplies normalized workspace pull request status. A daemon-side plugin handler uses the authenticated `gh` CLI to distinguish authored pull requests from review requests. If viewer lookup fails, PR Radar falls back conservatively and does not claim that a row needs the user.

## Install

Download the `pr-radar-vX.Y.Z.zip` asset from a GitHub release on the Paseo daemon host, then extract and install its top-level directory:

```bash
unzip pr-radar-vX.Y.Z.zip
cd pr-radar
bun install --frozen-lockfile
bunx paseo plugin install "$PWD"
```

The daemon must have plugins enabled and `gh` authenticated for GitHub viewer-aware triage.

## Develop

```bash
bun install
bun run check
bun test
bun run test:coverage
bun run typecheck
bunx paseo plugin install "$PWD"
bunx paseo plugin reload pr-radar
```

Release Please maintains the version, changelog, tags, and GitHub releases from Conventional Commits. Each release includes an installable `pr-radar-vX.Y.Z.zip` archive.

The project targets Paseo 0.6. React 19.1 and React Native 0.81 match the versions supplied by the plugin host.
