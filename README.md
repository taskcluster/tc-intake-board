# Project Date Sync

Adds temporal awareness to a GitHub Projects v2 board by filling missing intake, completion, week, and source fields. It is designed to be idempotent and does not overwrite existing project values.

## Setup

1. Create or verify these Project v2 fields:
   - Intake date: Date
   - Completed date: Date
   - Intake week: Text
   - Completed week: Text
   - Completed source: Single select with options `closedAt`, `project-done-observed`, `manual`

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
- Uses the project item `createdAt` timestamp for `Intake date`.
- Uses issue or pull request `closedAt` for `Completed date` when available.
- Uses the observed project `Done` status date as a fallback.
- Uses UTC dates.
- Derives ISO week values as `YYYY-Www`.

## Configuration

Environment variables:

```sh
ORG=taskcluster
PROJECT_NUMBER=23
GH_TOKEN=...
DRY_RUN=false
VERBOSE=false
DONE_STATUS_VALUES=Done,Closed,Completed,Complete,Resolved
```

`DONE_STATUS_VALUES` accepts a comma-separated list, for example:

```sh
DONE_STATUS_VALUES="Done,Closed"
```

## Limitations

- v1 does not create project fields.
- v1 assumes project item `fieldValues` fit within the first 100 values.
- v1 records the first observed project Done date if `closedAt` is unavailable.
- v1 does not clear dates when issues are reopened.

## Troubleshooting

- Missing token: set `GH_TOKEN` locally or configure the `PROJECTS_TOKEN` repository secret for Actions.
- Missing project fields: create `Intake date` and `Completed date` as Date fields.
- Token lacks project scope: refresh or replace the token with organization project read/write permissions.
- Completed source options missing: add `closedAt`, `project-done-observed`, and `manual` to the `Completed source` single-select field.

## Development

```sh
npm test
DRY_RUN=true npm run sync
```
