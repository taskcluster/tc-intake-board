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

## Configuration

Environment variables:

```sh
ORG=taskcluster
PROJECT_NUMBER=23
GH_TOKEN=...
DRY_RUN=false
VERBOSE=false
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
