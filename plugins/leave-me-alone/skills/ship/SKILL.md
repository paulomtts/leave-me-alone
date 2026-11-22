---
name: ship
description: Ship finished work end-to-end — commit, push, open a PR, watch CI and fix failures, squash-merge, cut a GitHub release, and with `--reinstall` update the locally installed Claude Code plugin. Use when the user says "/ship", "ship it", "push, PR, merge and release", or asks to take a change all the way to a release.
---

# ship

Take the current change from a working tree to a published release, without stopping between steps. Arguments: `--reinstall` (optional) also reinstalls the plugin locally at the end.

Typing `/ship` is the user's go-ahead to commit, push, merge and release this change. It does not cover anything else: never force-push, never merge someone else's PR, never release unrelated work sitting on the default branch.

## 1. Prepare

1. **Branch.** If on the default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), create a feature branch named after the change first. If a PR already exists for the current branch (`gh pr view`), reuse it.
2. **Version.** Find the repo's version source (`.claude-plugin/plugin.json`, `package.json`, `pyproject.toml`, `Cargo.toml`, …). If the change is not already bumped past the latest release (`gh release list --limit 1`, `git tag --sort=-creatordate`), bump it: patch for fixes, minor for new or renamed features, major only if the user said so. Mirror the bump anywhere the repo repeats the version (README, changelog). No version source means no release in step 5; say so.
3. **Gate.** Run the repo's verification commands (`npm test`, the CI config's steps, the README's instructions). If they fail, fix the cause; never weaken a test to pass.
4. **Commit** everything belonging to the change, following the repo's message style (check `git log`), ending with the attribution lines the session asks for. Never commit secrets or `.env` files; warn instead.

## 2. Push and open the PR

```
git push -u origin <branch>
gh pr create --title "<title>" --body "<summary, test results, attribution>"
```

Match recent PR titles (`gh pr list --state merged --limit 5`), e.g. putting the version in the title.

## 3. Watch CI

```
gh pr checks <pr> --watch --fail-fast
```

- **No checks configured:** note it and move on; the local gate from step 1 is the evidence.
- **A check fails:** read the log (`gh run view <run-id> --log-failed`), find the root cause, fix, commit, push, and watch again. Re-run once if it looks flaky (`gh run rerun <run-id> --failed`). After 3 failed fix attempts, stop and report: what failed, what you tried, and your recommended next step. Do not merge over red.
- **Merge blocked by required reviews:** stop and say so; do not bypass with `--admin`.

## 4. Merge

```
gh pr merge <pr> --squash --delete-branch
git switch <default-branch> && git pull
```

Use the merge method the repo uses (look at recent merges) if it is not squash.

## 5. Release

Tag the merge commit with the new version and publish a release:

```
gh release create v<version> --target <default-branch> --title "<version>" --notes "<what changed, (#pr)>"
```

Follow the existing tag format if there is one (`v1.2.3` vs `1.2.3`). If the tag already exists, stop: the version was not bumped.

## 6. Reinstall (only with `--reinstall`)

For a Claude Code plugin repo: read the marketplace name and its plugins from `.claude-plugin/marketplace.json`, then

```
claude plugin marketplace update <marketplace>
claude plugin update <plugin>@<marketplace>
```

for each plugin the change touched. Confirm the reported version is the one just released, and tell the user to restart Claude Code to apply it. If the repo is not a plugin marketplace, say `--reinstall` does not apply and skip it.

## Report

End with one short block: PR link, CI result, merge commit, release link, and the reinstalled version (or what stopped the flow and why).

## Common mistakes

- Releasing without bumping the version, or tagging a version that already exists.
- Merging while checks are still pending or red.
- Polling `gh pr checks` in a loop instead of `--watch`.
- Forgetting to pull the default branch after merging, so the release targets a stale commit.
- Reinstalling without `--reinstall`, or forgetting to tell the user to restart.
