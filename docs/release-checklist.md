# Release checklist

Nothing here runs by itself. The first part is checks an agent may run. The second part publishes, and an agent never runs it on its own: only when the user asks.

## Before every release

Run these from a clean working tree at the commit to release, and name that commit in the release report. Run `npm install` first if `node_modules` is missing.

1. **The four verification commands.** All must pass.

   ```bash
   npm run typecheck
   orca plugin test . --json      # exit code 0, TAP "# fail 0"
   orca plugin validate . --json
   orca plugin check . --json
   ```

2. **Inspect the plugin.** Compare what Orca says it asks for with the Permissions and Settings sections of [docs/reference.md](reference.md): every capability, hook and event has a line under Permissions, and every setting has a line under Settings. The file count must be at most 2,000 and the size at most 50 MiB.

   `orca plugin inspect` fails in the working folder because of the symlinks in `node_modules/.bin`, so run it on an export of the commit:

   ```bash
   export_dir=$(mktemp -d)
   git archive HEAD | tar -x -C "$export_dir"
   orca plugin inspect "$export_dir" --json
   ```

   The content hash matches the one `orca plugin release-entry . --json` prints. Uncommitted files are in neither. Put the file count, the size and the content hash in the release report, labelled "at <commit>". Never write them into a file in the repository: that would change the hash.

3. **The size.** The catalog holds a version for manual review when the inspected `totalBytes` is over about 5 MiB; it held 0.3.0, at 5,415,318 B. Keep `totalBytes` under 5,000,000 and record it in the release report.

4. **A privacy scan.**
   - `git grep -n -i -E '<terms>'`, with terms the user supplies at release time. The terms are never written into the repository.
   - `git grep -n -E '/Users/|/home/|~/' -- ':!docs/release-checklist.md'` for absolute local paths. Review every hit. The docs' `~/.orca-azure-devops` and `~/.azure`, and the `/Users/ada` and `/home/vsts` paths in tests and fixtures, are expected.
   - Review every GUID that `git grep -n -i -E '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'` finds. Only fixtures, the all-zero placeholder and the Azure DevOps application ID `499b84ac-…` may remain.
   - The planning documents that were under `docs/superpowers/` and `docs/research/` are now kept outside this repository and no longer ship. Commits up to `v0.3.0` still hold them, with the author's employer and local paths, so the history scan below lists those commits.
   - Scan the history too, because publishing pushes every commit and `git grep` sees only the checked-out files. These list the commits that added or removed a matching line:

     ```bash
     git log --all -E -i -G '<terms>' --format='%h %s' -- . ':!docs/release-checklist.md'
     git log --all -E -G '/Users/|/home/|~/' --format='%h %s' -- . ':!docs/release-checklist.md'
     ```

     Redacting or deleting a file in a new commit does not remove it from history. Review every commit listed (the expected paths from the previous bullet appear too). Whatever is not acceptable stays readable in a pushed history, so the user decides between publishing a squashed or rewritten history and accepting it.

5. **Images.** The icon and screenshots meet Orca's rules, which `worker/manifest.test.ts` checks, and the screenshots show fixture data only.

   The cover and screenshots are composed from `orca plugin shot` scenario and editor shots of fixture data, with a kit kept outside this repository, and each is encoded to JPEG once.

6. **The docs.** The settings list in [docs/reference.md](reference.md) matches the manifest, the pending live checks in [docs/development.md](development.md) are current, and the README stays a short landing page.

7. **The license.** MIT ([Plan 1](https://github.com/kloppers-labs/orca-azure-devops/blob/v0.3.0/docs/superpowers/plans/2026-11-03-plan-1-foundation.md)'s call). The user confirms it.

8. **The version.** `version` is the same in `orca-plugin.json` and `package.json`.

## Publishing

Only when the user asks. The repository belongs to the `kloppers-labs` organisation; GitHub work uses the CanadianMapleFarmer account's credentials, which administers it.

1. Create the public repository `kloppers-labs/orca-azure-devops` and push `main`.
2. Set `version` and commit. That is a new commit, so run Before every release again on it and use its figures in the release report. Then `git tag -a v<version> -m v<version>` and push the tag.
3. Add the topic: `gh repo edit kloppers-labs/orca-azure-devops --add-topic orca-plugin`.
4. Check the listing at `https://www.onorca.dev/plugins/kloppers-labs/orca-azure-devops`.
5. For a catalog, run `orca plugin release-entry . --json` at the tag and paste its entry into that catalog's `orca-catalog.json` `releases`, newest first.
6. Install from the listing on a clean Orca profile and follow [docs/connecting.md](connecting.md) to connect an organisation.
