# Security: self-hosted runner trust model

This repository is **public**. The collector workflow (`.github/workflows/collect.yml`)
runs on a self-hosted runner. This document explains what that means, what is mitigated,
and what is not, so you can decide whether — and on what machine — to run it.

## The core risk

A self-hosted runner executes the repository's workflows. On a **public** repo, that
means it executes code that **anyone who can push to the repo** can introduce — and,
depending on trigger configuration, code that **anyone who can open a pull request** can
introduce. A self-hosted runner is not sandboxed the way GitHub-hosted runners are: it
runs as whatever user you registered it under, on your hardware, with that user's
permissions. Treat it as running untrusted code.

## What is mitigated here

1. **No pull-request triggers.** Neither workflow declares `pull_request` or
   `pull_request_target`. `pull_request_target` is the dangerous one — it runs the *base*
   repository's workflow (with its runner and any secrets) on code from a *fork* PR. We
   do not use it. Fork PRs therefore cannot run anything on the recorder.
2. **Push is restricted to the default branch.** Only people with push access to this
   repo can trigger a push event at all, and the collector only reacts to the default
   branch.
3. **Least-privilege `GITHUB_TOKEN`.** Both workflows set `permissions: contents: read`.
   Artifact upload uses the runner's runtime token (not the `GITHUB_TOKEN`), so no
   repo-scoped write credential is ever granted. The workflow has no write access to the
   repository.
4. **Read-only dataset scope.** The collector only writes to its own local `./data`
   directory. It has no path to push anything back to the repository, and the dataset it
   produces is synced out-of-band by the operator.

## What cannot be engineered away

- **Anyone with push access can run arbitrary code on the runner.** The mitigations above
  narrow *who* can do this to repository collaborators, but do not eliminate it: a
  compromised collaborator account, or a malicious merge, runs code on your machine. On a
  public repo this is an accepted, irreducible risk.
- **The runner is long-lived and network-connected.** It holds a connection to the public
  Polymarket feed and lives on your machine/box for days at a time.
- **Supply chain.** `npm ci` installs third-party packages. A compromised dependency runs
  on the runner. (This is also true of the analysis job, but there it runs on GitHub's
  hardware, not yours.)

## Recommendation

Do **not** run the self-hosted runner on a machine that also holds anything sensitive —
personal files, other projects' credentials, a wallet, work email. Use a **dedicated
account and/or a dedicated box** (a cheap VPS or an old machine) whose only job is the
recorder, with nothing else on it. If the box is compromised, you lose nothing but the
recorder, which is fully regenerable from the public feed.

## The alternative: no self-hosted runner at all

If you are unwilling to accept the above, you can skip the recorder workflow entirely:

- Run the collector directly on a VPS with `npm run collect` (the collector is just a
  Node process; it needs no GitHub runner to run).
- Keep using GitHub Actions **only for the analysis half** (`analyze.yml`), which runs on
  GitHub-hosted runners and executes nothing but this repo's own code.

That gives you 24/7 recording with no self-hosted trust exposure, at the cost of losing
the convenience of the Actions-based recorder lifecycle.
