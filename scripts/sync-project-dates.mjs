import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENED_WEEK_FIELD_NAMES = ["Opened week", "Intake week"];
const COMPLETED_WEEK_FIELD_NAME = "Completed week";

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
      items(first: 100, after: $cursor) {
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

  return updates;
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

function graphql(query, variables = {}) {
  const variableArgs = Object.entries(variables).flatMap(([name, value]) => {
    if (value === undefined || value === null) {
      return [];
    }
    return ["-F", `${name}=${value}`];
  });

  const result = spawnSync(
    "gh",
    ["api", "graphql", "-f", `query=${query}`, ...variableArgs],
    {
      env: process.env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`Failed to run gh api graphql: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `gh api graphql failed with exit code ${result.status}:\n${result.stderr}`,
    );
  }

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
    fields: fieldValues,
  };
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
