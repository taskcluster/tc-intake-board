# Project Date Sync

Adds week-level reporting to a GitHub Projects v2 board by filling missing opened and completed week fields. It is designed to be idempotent and does not overwrite existing project values.

## Setup

1. Create or verify these Project v2 fields:
   - Opened week: Text
   - Completed week: Text

   The legacy `Intake week` field name is still supported as the opened-week target.

2. Create a token:
   - Preferred production option: GitHub App installation token with project read/write permissions.
   - Simpler prototype option: classic PAT with `project` scope.

3. Add the repository secret:
   - `PROJECTS_TOKEN`

4. Run manually:
   - Actions -> Sync project dates -> Run workflow
   - Use `dry_run=true` first.

5. Local development:

   ```sh
   gh auth refresh -s project
   export ORG=taskcluster
   export PROJECT_NUMBER=23
   export GH_TOKEN=$(gh auth token)
   DRY_RUN=true npm run sync
   ```

GitHub's documentation recommends a GitHub App for organization project automation, with a PAT as a simpler alternative for prototypes. See GitHub's docs for [automating Projects using Actions](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions) and [using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).

## Behavior

- Does not overwrite existing values.
- Reads GitHub Projects' built-in `Created` field for opened-week values.
- Reads GitHub Projects' built-in `Closed` field for completed-week values.
- Falls back to issue or pull request `createdAt`/`closedAt` values if the built-in field value is absent.
- Only updates text week fields.
- Uses UTC dates.
- Derives ISO week values as `YYYY-Www`.

## PR lifecycle labeling

For **open pull requests**, the sync also computes a single PR-lifecycle label from observable
GitHub state and writes it to an optional single-select project field.

Create this field on the board to enable it (the script validates but does not create fields):

- `PR lifecycle`: Single select, with these options (names must match exactly):
  - `pr-author-action-needed`
  - `pr-blocked`
  - `pr-ready-to-merge`
  - `pr-review-pending`
  - `pr-stale`
  - `pr-draft-or-not-ready`

If the field is absent or not single-select, lifecycle labeling is skipped with a warning and the
date sync continues unaffected.

Exactly one label is assigned, chosen by the first matching rule in this priority order:

`pr-author-action-needed` > `pr-blocked` > `pr-ready-to-merge` > `pr-review-pending` > `pr-stale` > `pr-draft-or-not-ready`

| Label | When |
|---|---|
| `pr-author-action-needed` | Changes requested, a failing **Taskcluster** check, or unresolved review threads. |
| `pr-blocked` | Has a `blocked` label, or the body says `depends on #N` / `blocked by #N` / `blocked by:`. |
| `pr-ready-to-merge` | Not draft, approved, mergeable, CI passing (or none configured), no unresolved threads. |
| `pr-review-pending` | Not draft, with reviewers requested or review explicitly required. Also the default for an open non-draft PR with nothing else pending. |
| `pr-stale` | No activity for 7+ days and not blocked (reachable only when no reviewers are assigned, since review-pending outranks stale). |
| `pr-draft-or-not-ready` | Draft, or `WIP`/`draft:` in the title. |

Unlike the week fields, the lifecycle label is **recomputed and overwritten every run** because it is
dynamic. Issues and closed/merged PRs are left untouched.

### CI signal (Taskcluster only)

Only **Taskcluster** checks count toward the CI part of the rules — other checks (GitHub Actions,
Codecov, etc.) are ignored. A check is treated as Taskcluster when its status-context string,
check-run name, or GitHub App slug matches a pattern (default `taskcluster|community-tc`,
case-insensitive). If a repo has no Taskcluster checks, CI is treated as non-blocking (it neither
blocks merge nor triggers author-action).

Override the matcher with `TASKCLUSTER_CHECK_PATTERN` (a case-insensitive regex) if a deployment
uses a different app slug or context name. To see what your PRs actually report, inspect a PR's
checks:

```sh
gh api graphql -f query='
query { repository(owner:"taskcluster", name:"taskcluster") { pullRequest(number: 8514) {
  commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
    __typename ... on CheckRun{name checkSuite{app{slug}} conclusion}
    ... on StatusContext{context state}}}}}}} } } }'
```

### Lifecycle limitations

- `pr-blocked` is best-effort: only an explicit `blocked` label or `depends on`/`blocked by` markers
  in the body are detected. External-team, infra-outage, or decision blockers are not observable and
  will not be caught.
- Only the first 50 review threads per PR are inspected for unresolved state.
- Only the first 100 status checks on the latest commit are inspected; a Taskcluster failure beyond
  the first 100 contexts could be missed on very large PRs.

## Configuration

Environment variables:

```sh
ORG=taskcluster
PROJECT_NUMBER=23
GH_TOKEN=...
DRY_RUN=false
VERBOSE=false
TASKCLUSTER_CHECK_PATTERN=taskcluster|community-tc
```

## Limitations

- v1 does not create project fields.
- v1 assumes project item `fieldValues` fit within the first 100 values.
- v1 only fills `Completed week` when GitHub has a closed date.
- v1 does not clear week fields when issues are reopened.

## Troubleshooting

- Missing token: set `GH_TOKEN` locally or configure the `PROJECTS_TOKEN` repository secret for Actions.
- Invalid authorization header: recreate `PROJECTS_TOKEN` with the raw token value only. Do not include quotes, `Bearer`, `token`, a private key, JSON, or trailing newlines.
- Missing project fields: create `Opened week` and `Completed week` as Text fields.
- Token lacks project scope: refresh or replace the token with organization project read/write permissions.

## Development

```sh
npm test
DRY_RUN=true npm run sync
```
