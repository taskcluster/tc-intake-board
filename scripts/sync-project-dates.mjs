import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENED_WEEK_FIELD_NAMES = ["Opened week", "Intake week"];
const COMPLETED_WEEK_FIELD_NAME = "Completed week";

const PR_LIFECYCLE_FIELD_NAME = "PR lifecycle";
const PR_LIFECYCLE_OPTIONS = Object.freeze([
  "pr-author-action-needed",
  "pr-blocked",
  "pr-ready-to-merge",
  "pr-review-pending",
  "pr-stale",
  "pr-draft-or-not-ready",
]);
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// Each item now carries heavy per-item sub-selections (status check contexts,
// reviewThreads) on top of fieldValues. Keep the page small so a single
// paginated query stays under GitHub's GraphQL execution timeout (large pages
// were returning HTTP 502). Pagination still covers the whole board.
const ITEMS_PAGE_SIZE = 10;

// CI is judged only on Taskcluster checks. A check counts as Taskcluster if its
// status-context string, check-run name, or GitHub App slug matches this
// pattern. Override with TASKCLUSTER_CHECK_PATTERN (a case-insensitive regex)
// if a deployment uses a different app slug or context name.
const TASKCLUSTER_CHECK_PATTERN = process.env.TASKCLUSTER_CHECK_PATTERN
  ? new RegExp(process.env.TASKCLUSTER_CHECK_PATTERN, "i")
  : /taskcluster|community-tc/i;

const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

const PROJECT_QUERY = `
query($org: String!, $projectNumber: Int!) {
  organization(login: $org) {
    projectV2(number: $projectNumber) {
      id
      title
    }
  }
}
`;

const FIELDS_QUERY = `
query($org: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $projectNumber) {
      fields(first: 100, after: $cursor) {
        nodes {
          __typename
          ... on ProjectV2Field {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
          ... on ProjectV2IterationField {
            id
            name
            dataType
            configuration {
              iterations {
                id
                title
                startDate
                duration
              }
              completedIterations {
                id
                title
                startDate
                duration
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const ITEMS_QUERY = `
query($org: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $org) {
    projectV2(number: $projectNumber) {
      items(first: ${ITEMS_PAGE_SIZE}, after: $cursor) {
        nodes {
          id
          createdAt
          type
          content {
            __typename
            ... on Issue {
              id
              number
              title
              url
              createdAt
              closed
              closedAt
            }
            ... on PullRequest {
              id
              number
              title
              url
              createdAt
              closed
              closedAt
              merged
              mergedAt
              isDraft
              updatedAt
              mergeable
              reviewDecision
              bodyText
              labels(first: 20) {
                nodes {
                  name
                }
              }
              reviewRequests(first: 1) {
                totalCount
              }
              reviewThreads(first: 50) {
                totalCount
                nodes {
                  isResolved
                }
              }
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup {
                      contexts(first: 100) {
                        nodes {
                          __typename
                          ... on CheckRun {
                            name
                            status
                            conclusion
                            checkSuite {
                              app {
                                slug
                              }
                            }
                          }
                          ... on StatusContext {
                            context
                            state
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          fieldValues(first: 100) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldDateValue {
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
                date
              }
              ... on ProjectV2ItemFieldTextValue {
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
                text
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
                name
                optionId
              }
              ... on ProjectV2ItemFieldIterationValue {
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
                title
                startDate
                duration
              }
              ... on ProjectV2ItemIssueFieldValue {
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                    dataType
                  }
                }
                issueFieldValue {
                  __typename
                  ... on IssueFieldDateValue {
                    value
                    field {
                      ... on IssueFieldDate {
                        id
                        name
                        dataType
                      }
                    }
                  }
                  ... on IssueFieldTextValue {
                    value
                    field {
                      ... on IssueFieldText {
                        id
                        name
                        dataType
                      }
                    }
                  }
                  ... on IssueFieldNumberValue {
                    value
                    field {
                      ... on IssueFieldNumber {
                        id
                        name
                        dataType
                      }
                    }
                  }
                  ... on IssueFieldSingleSelectValue {
                    name
                    value
                    optionId
                    field {
                      ... on IssueFieldSingleSelect {
                        id
                        name
                        dataType
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const UPDATE_TEXT_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { text: $text }
  }) {
    projectV2Item {
      id
    }
  }
}
`;

const UPDATE_SINGLE_SELECT_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item {
      id
    }
  }
}
`;

export function toDateOnly(isoDateTime) {
  if (typeof isoDateTime !== "string" || isoDateTime.trim() === "") {
    return "";
  }

  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${isoDateTime}`);
  }

  return date.toISOString().slice(0, 10);
}

export function isoWeekString(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error(`Invalid date-only value: ${dateString}`);
  }

  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date-only value: ${dateString}`);
  }

  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);

  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);

  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

export function validateOrgName(org) {
  if (typeof org !== "string" || !/^[A-Za-z0-9_-]+$/.test(org)) {
    throw new Error(
      `ORG must be a GitHub organization login containing only letters, numbers, hyphens, or underscores; got ${org}`,
    );
  }
}

export function validateGithubToken(token) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(
      "GH_TOKEN is required. In GitHub Actions set GH_TOKEN=${{ secrets.PROJECTS_TOKEN }}; locally use a token with project scope.",
    );
  }

  if (token !== token.trim() || /\s/.test(token)) {
    throw new Error(
      "GH_TOKEN/PROJECTS_TOKEN must be the raw GitHub token only, with no whitespace, newlines, quotes, or token/Bearer prefix. Recreate the repository secret with just the token value.",
    );
  }

  if (/^(bearer|token)\s+/i.test(token)) {
    throw new Error(
      "GH_TOKEN/PROJECTS_TOKEN must not include a token type prefix. Recreate the repository secret with just the token value.",
    );
  }
}

export function classifyPullRequest(pr, { now = new Date() } = {}) {
  if (!pr || pr.closed || pr.merged) {
    return null;
  }

  const isDraft = pr.isDraft === true || isWipTitle(pr.title);
  const ciFailing = pr.ciFailing === true;
  const ciPassing = !pr.ciFailing && !pr.ciPending;
  const hasUnresolvedThreads = (pr.unresolvedThreadCount ?? 0) > 0;
  const blocked = isBlockedPullRequest(pr);

  // Priority order:
  // author-action-needed > blocked > ready-to-merge > review-pending > stale > draft.
  if (
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    ciFailing ||
    hasUnresolvedThreads
  ) {
    return "pr-author-action-needed";
  }

  if (blocked) {
    return "pr-blocked";
  }

  if (
    !isDraft &&
    pr.reviewDecision === "APPROVED" &&
    pr.mergeable === "MERGEABLE" &&
    ciPassing &&
    !hasUnresolvedThreads
  ) {
    return "pr-ready-to-merge";
  }

  if (
    !isDraft &&
    (pr.reviewDecision === "REVIEW_REQUIRED" ||
      (pr.reviewRequestCount ?? 0) > 0)
  ) {
    return "pr-review-pending";
  }

  if (isStale(pr.updatedAt, now)) {
    return "pr-stale";
  }

  if (isDraft) {
    return "pr-draft-or-not-ready";
  }

  // Open, non-draft, recent, no explicit reviewers, not approved: gentlest bucket.
  return "pr-review-pending";
}

function isWipTitle(title) {
  return typeof title === "string" && /\bwip\b|^\s*draft:/i.test(title);
}

function isBlockedPullRequest(pr) {
  const labelNames = pr.labelNames ?? [];
  if (labelNames.some((name) => String(name).toLowerCase() === "blocked")) {
    return true;
  }

  const body = pr.bodyText ?? "";
  return /\b(?:depends on|blocked by)\b\s*(?::|#\d+)/i.test(body);
}

function isStale(updatedAt, now) {
  if (isEmptyValue(updatedAt)) {
    return false;
  }

  const updated = new Date(updatedAt);
  if (Number.isNaN(updated.getTime())) {
    return false;
  }

  return now.getTime() - updated.getTime() >= STALE_AFTER_MS;
}

export function buildPlannedUpdates(item, fields) {
  const itemFields = item.fields ?? {};
  const updates = [];

  const openedWeekField = getOpenedWeekField(fields);
  const completedWeekField = getField(fields, COMPLETED_WEEK_FIELD_NAME);

  const openedDate = firstDateOnly(
    itemFields.Created,
    item.openedAt,
    item.contentCreatedAt,
    item.createdAt,
  );
  if (
    isEmptyValue(itemFields[openedWeekField?.name]) &&
    supportsFieldType(openedWeekField, "TEXT") &&
    !isEmptyValue(openedDate)
  ) {
    updates.push(
      makeUpdate(item, openedWeekField, "text", isoWeekString(openedDate)),
    );
  }

  const completedDate = firstDateOnly(itemFields.Closed, item.closedAt);

  if (
    isEmptyValue(itemFields[COMPLETED_WEEK_FIELD_NAME]) &&
    supportsFieldType(completedWeekField, "TEXT") &&
    !isEmptyValue(completedDate)
  ) {
    updates.push(
      makeUpdate(
        item,
        completedWeekField,
        "text",
        isoWeekString(completedDate),
      ),
    );
  }

  const lifecycleUpdate = buildLifecycleUpdate(item, fields);
  if (lifecycleUpdate) {
    updates.push(lifecycleUpdate);
  }

  return updates;
}

function buildLifecycleUpdate(item, fields, { now } = {}) {
  if (!item.pullRequest) {
    return null;
  }

  const field = getField(fields, PR_LIFECYCLE_FIELD_NAME);
  if (!field || field.dataType !== "SINGLE_SELECT") {
    return null;
  }

  const label = classifyPullRequest(item.pullRequest, { now });
  if (!label) {
    return null;
  }

  const option = (field.options ?? []).find((opt) => opt.name === label);
  if (!option) {
    return null;
  }

  // Lifecycle is dynamic: recompute every run and overwrite when it changes,
  // unlike the never-overwrite week fields.
  if (item.fields?.[PR_LIFECYCLE_FIELD_NAME] === label) {
    return null;
  }

  return makeUpdate(item, field, "singleSelect", label, {
    optionId: option.id,
  });
}

function makeUpdate(item, field, type, value, extra = {}) {
  return {
    itemId: item.id,
    contentUrl: item.contentUrl ?? "",
    fieldId: field.id,
    fieldName: field.name,
    type,
    value,
    ...extra,
  };
}

function isEmptyValue(value) {
  return value === undefined || value === null || value === "";
}

function supportsFieldType(field, expectedType) {
  return Boolean(field) && (!field.dataType || field.dataType === expectedType);
}

function firstDateOnly(...values) {
  for (const value of values) {
    if (!isEmptyValue(value)) {
      return toDateOnly(value);
    }
  }

  return "";
}

function getOpenedWeekField(fields) {
  for (const fieldName of OPENED_WEEK_FIELD_NAMES) {
    const field = getField(fields, fieldName);
    if (field) {
      return field;
    }
  }

  return null;
}

function getField(fields, name) {
  if (!fields) {
    return null;
  }

  if (fields instanceof Map) {
    return fields.get(name) ?? null;
  }

  return fields[name] ?? null;
}

const GRAPHQL_MAX_ATTEMPTS = 4;

function graphql(query, variables = {}) {
  const variableArgs = Object.entries(variables).flatMap(([name, value]) => {
    if (value === undefined || value === null) {
      return [];
    }
    return ["-F", `${name}=${value}`];
  });

  let lastErrorMessage = "gh api graphql failed";

  for (let attempt = 1; attempt <= GRAPHQL_MAX_ATTEMPTS; attempt += 1) {
    const result = spawnSync(
      "gh",
      ["api", "graphql", "-f", `query=${query}`, ...variableArgs],
      {
        env: process.env,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    if (!result.error && result.status === 0) {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error(`Failed to parse gh api graphql output: ${error.message}`);
      }

      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        const messages = parsed.errors
          .map((apiError) => apiError.message ?? JSON.stringify(apiError))
          .join("\n");
        throw new Error(`GitHub GraphQL returned errors:\n${messages}`);
      }

      return parsed.data;
    }

    const stderr = result.stderr ?? "";
    lastErrorMessage = result.error
      ? `Failed to run gh api graphql: ${result.error.message}`
      : `gh api graphql failed with exit code ${result.status}:\n${stderr}`;

    const retryable = isTransientGhError(result, stderr);
    if (retryable && attempt < GRAPHQL_MAX_ATTEMPTS) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        `Warning: transient GitHub error (attempt ${attempt}/${GRAPHQL_MAX_ATTEMPTS}), retrying in ${delayMs}ms...`,
      );
      sleepSync(delayMs);
      continue;
    }

    break;
  }

  throw new Error(lastErrorMessage);
}

function isTransientGhError(result, stderr) {
  // spawn-level failure (e.g. network reset) or a server-side 5xx / rate-limit /
  // timeout reported by gh. GraphQL validation errors are status 0 and handled
  // separately, so they never reach here and are never retried.
  if (result.error) {
    return true;
  }
  return /\bHTTP (?:5\d{2}|408|429)\b/i.test(stderr) || /timeout/i.test(stderr);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveProject(org, projectNumber) {
  const data = graphql(PROJECT_QUERY, { org, projectNumber });
  const project = data?.organization?.projectV2;
  if (!project) {
    throw new Error(`Project not found: ${org}/${projectNumber}`);
  }
  return project;
}

function fetchProjectFields(org, projectNumber) {
  const fields = [];
  let cursor;

  do {
    const data = graphql(FIELDS_QUERY, { org, projectNumber, cursor });
    const project = data?.organization?.projectV2;
    if (!project) {
      throw new Error(`Project not found while fetching fields: ${org}/${projectNumber}`);
    }

    fields.push(...project.fields.nodes.filter(Boolean).map(normalizeProjectField));
    cursor = project.fields.pageInfo.hasNextPage
      ? project.fields.pageInfo.endCursor
      : null;
  } while (cursor);

  return fields;
}

function fetchProjectItems(org, projectNumber) {
  const items = [];
  let cursor;

  do {
    const data = graphql(ITEMS_QUERY, { org, projectNumber, cursor });
    const project = data?.organization?.projectV2;
    if (!project) {
      throw new Error(`Project not found while fetching items: ${org}/${projectNumber}`);
    }

    items.push(...project.items.nodes.filter(Boolean).map(normalizeItem));
    cursor = project.items.pageInfo.hasNextPage
      ? project.items.pageInfo.endCursor
      : null;
  } while (cursor);

  return items;
}

function normalizeProjectField(field) {
  return {
    id: field.id,
    name: field.name,
    dataType: field.dataType,
    options: field.options ?? [],
  };
}

function buildFieldsByName(fields) {
  return new Map(fields.map((field) => [field.name, field]));
}

function normalizeItem(item) {
  const fieldValues = {};

  for (const fieldValue of item.fieldValues?.nodes ?? []) {
    const fieldName = fieldValue?.field?.name
      ?? fieldValue?.issueFieldValue?.field?.name;
    if (!fieldName) {
      continue;
    }

    if (fieldValue.issueFieldValue) {
      fieldValues[fieldName] = normalizeIssueFieldValue(fieldValue.issueFieldValue);
    } else if (Object.hasOwn(fieldValue, "date")) {
      fieldValues[fieldName] = fieldValue.date ?? "";
    } else if (Object.hasOwn(fieldValue, "text")) {
      fieldValues[fieldName] = fieldValue.text ?? "";
    } else if (Object.hasOwn(fieldValue, "name")) {
      fieldValues[fieldName] = fieldValue.name ?? "";
    } else if (Object.hasOwn(fieldValue, "title")) {
      fieldValues[fieldName] = fieldValue.title ?? "";
    }
  }

  return {
    id: item.id,
    createdAt: item.createdAt,
    openedAt: fieldValues.Created ?? item.content?.createdAt ?? item.createdAt,
    contentCreatedAt: item.content?.createdAt ?? "",
    contentType: item.content?.__typename ?? item.type ?? "",
    contentUrl: item.content?.url ?? "",
    closedAt: fieldValues.Closed ?? item.content?.closedAt ?? "",
    pullRequest: normalizePullRequest(item.content),
    fields: fieldValues,
  };
}

function normalizePullRequest(content) {
  if (content?.__typename !== "PullRequest") {
    return null;
  }

  const reviewThreadNodes = content.reviewThreads?.nodes ?? [];
  const checkContexts =
    content.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ??
    [];
  const taskclusterContexts = checkContexts.filter(isTaskclusterCheck);

  return {
    title: content.title ?? "",
    isDraft: content.isDraft === true,
    closed: content.closed === true,
    merged: content.merged === true,
    updatedAt: content.updatedAt ?? "",
    mergeable: content.mergeable ?? null,
    reviewDecision: content.reviewDecision ?? null,
    bodyText: content.bodyText ?? "",
    labelNames: (content.labels?.nodes ?? []).map((node) => node?.name ?? ""),
    reviewRequestCount: content.reviewRequests?.totalCount ?? 0,
    unresolvedThreadCount: reviewThreadNodes.filter(
      (node) => node?.isResolved === false,
    ).length,
    // Only Taskcluster checks are considered. No matching check => neither
    // failing nor pending (treated as non-blocking, like having no CI).
    ciFailing: taskclusterContexts.some(isFailingCheck),
    ciPending: taskclusterContexts.some(isPendingCheck),
  };
}

export function isTaskclusterCheck(context) {
  if (!context) {
    return false;
  }
  if (context.__typename === "CheckRun") {
    return (
      TASKCLUSTER_CHECK_PATTERN.test(context.name ?? "") ||
      TASKCLUSTER_CHECK_PATTERN.test(context.checkSuite?.app?.slug ?? "")
    );
  }
  if (context.__typename === "StatusContext") {
    return TASKCLUSTER_CHECK_PATTERN.test(context.context ?? "");
  }
  return false;
}

export function isFailingCheck(context) {
  if (context.__typename === "CheckRun") {
    return (
      context.status === "COMPLETED" &&
      FAILING_CHECK_CONCLUSIONS.has(context.conclusion)
    );
  }
  return context.state === "FAILURE" || context.state === "ERROR";
}

export function isPendingCheck(context) {
  if (context.__typename === "CheckRun") {
    return context.status !== "COMPLETED" || context.conclusion == null;
  }
  return context.state === "PENDING" || context.state === "EXPECTED";
}

function normalizeIssueFieldValue(issueFieldValue) {
  if (Object.hasOwn(issueFieldValue, "value")) {
    return issueFieldValue.value ?? "";
  }

  if (Object.hasOwn(issueFieldValue, "name")) {
    return issueFieldValue.name ?? "";
  }

  return "";
}

function validateFields(fieldsByName, warn) {
  const errors = [];

  const openedWeekField = getOpenedWeekField(fieldsByName);
  if (!openedWeekField) {
    errors.push(
      `Required opened-week field is missing. Create "Opened week" as a Text field, or keep legacy "Intake week".`,
    );
  } else if (openedWeekField.dataType !== "TEXT") {
    errors.push(
      `Opened-week field "${openedWeekField.name}" must be TEXT, found ${openedWeekField.dataType}.`,
    );
  }

  const completedWeekField = fieldsByName.get(COMPLETED_WEEK_FIELD_NAME);
  if (!completedWeekField) {
    errors.push(`Required field "${COMPLETED_WEEK_FIELD_NAME}" is missing.`);
  } else if (completedWeekField.dataType !== "TEXT") {
    errors.push(
      `Required field "${COMPLETED_WEEK_FIELD_NAME}" must be TEXT, found ${completedWeekField.dataType}.`,
    );
  }

  if (!fieldsByName.has("Opened week") && fieldsByName.has("Intake week")) {
    warn(`Using legacy field "Intake week" for opened-week updates.`);
  }

  const lifecycleField = fieldsByName.get(PR_LIFECYCLE_FIELD_NAME);
  if (!lifecycleField) {
    warn(
      `Optional field "${PR_LIFECYCLE_FIELD_NAME}" is missing; skipping PR lifecycle labeling.`,
    );
  } else if (lifecycleField.dataType !== "SINGLE_SELECT") {
    warn(
      `Field "${PR_LIFECYCLE_FIELD_NAME}" must be SINGLE_SELECT to enable lifecycle labeling, found ${lifecycleField.dataType}; skipping.`,
    );
  } else {
    const optionNames = new Set(
      (lifecycleField.options ?? []).map((option) => option.name),
    );
    const missingOptions = PR_LIFECYCLE_OPTIONS.filter(
      (name) => !optionNames.has(name),
    );
    if (missingOptions.length > 0) {
      warn(
        `Field "${PR_LIFECYCLE_FIELD_NAME}" is missing options: ${missingOptions.join(", ")}. Those labels cannot be applied until the options exist.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Project field validation failed:\n- ${errors.join("\n- ")}`);
  }
}

function executeUpdate(projectId, update) {
  if (update.type === "text") {
    graphql(UPDATE_TEXT_MUTATION, {
      projectId,
      itemId: update.itemId,
      fieldId: update.fieldId,
      text: update.value,
    });
    return;
  }

  if (update.type === "singleSelect") {
    graphql(UPDATE_SINGLE_SELECT_MUTATION, {
      projectId,
      itemId: update.itemId,
      fieldId: update.fieldId,
      optionId: update.optionId,
    });
    return;
  }

  throw new Error(`Unsupported update type: ${update.type}`);
}

function formatUpdate(update) {
  return `[${update.itemId}] Set "${update.fieldName}" = ${update.value}`;
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function readConfig() {
  validateGithubToken(process.env.GH_TOKEN);

  const org = process.env.ORG || "taskcluster";
  validateOrgName(org);

  const rawProjectNumber = process.env.PROJECT_NUMBER || "23";
  if (!/^\d+$/.test(rawProjectNumber)) {
    throw new Error(`PROJECT_NUMBER must be an integer, got ${process.env.PROJECT_NUMBER}`);
  }
  const projectNumber = Number.parseInt(rawProjectNumber, 10);

  return {
    org,
    projectNumber,
    dryRun: parseBoolean(process.env.DRY_RUN),
    verbose: parseBoolean(process.env.VERBOSE),
  };
}

function runSync() {
  const config = readConfig();
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    console.warn(`Warning: ${message}`);
  };

  const project = resolveProject(config.org, config.projectNumber);
  const fields = fetchProjectFields(config.org, config.projectNumber);
  const fieldsByName = buildFieldsByName(fields);

  validateFields(fieldsByName, warn);

  const items = fetchProjectItems(config.org, config.projectNumber);
  const plannedUpdates = items.flatMap((item) =>
    buildPlannedUpdates(item, fieldsByName),
  );

  let executed = 0;
  for (const update of plannedUpdates) {
    console.log(formatUpdate(update));
    if (config.verbose && update.contentUrl) {
      console.log(`  ${update.contentUrl}`);
    }

    if (!config.dryRun) {
      executeUpdate(project.id, update);
      executed += 1;
    }
  }

  console.log("");
  console.log(`Project: ${config.org}/${config.projectNumber} ${project.title}`);
  console.log(`Items scanned: ${items.length}`);
  console.log(`Mutations planned: ${plannedUpdates.length}`);
  console.log(`Mutations executed: ${executed}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Warnings: ${warnings.length}`);
}

function isDirectRun() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    : false;
}

if (isDirectRun()) {
  try {
    runSync();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
