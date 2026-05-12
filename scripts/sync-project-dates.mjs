import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DONE_STATUS_VALUES = [
  "Done",
  "Closed",
  "Completed",
  "Complete",
  "Resolved",
];

const REQUIRED_FIELDS = ["Intake date", "Completed date"];
const OPTIONAL_FIELDS = ["Intake week", "Completed week", "Completed source"];
const COMPLETED_SOURCE_OPTIONS = ["closedAt", "project-done-observed", "manual"];

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
              closed
              closedAt
            }
            ... on PullRequest {
              id
              number
              title
              url
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

const UPDATE_DATE_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { date: $date }
  }) {
    projectV2Item {
      id
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

export function parseDoneStatusValues(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return [...DEFAULT_DONE_STATUS_VALUES];
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : [...DEFAULT_DONE_STATUS_VALUES];
}

export function isDoneStatus(value, doneValues) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  return doneValues.some(
    (doneValue) => doneValue.trim().toLowerCase() === normalizedValue,
  );
}

export function validateOrgName(org) {
  if (typeof org !== "string" || !/^[A-Za-z0-9_-]+$/.test(org)) {
    throw new Error(
      `ORG must be a GitHub organization login containing only letters, numbers, hyphens, or underscores; got ${org}`,
    );
  }
}

export function buildPlannedUpdates(item, fields, options = {}) {
  const doneValues = options.doneValues ?? DEFAULT_DONE_STATUS_VALUES;
  const today = options.today ?? todayUtcDate();
  const completedSourceOptions = options.completedSourceOptions ?? null;
  const itemFields = item.fields ?? {};
  const updates = [];

  const intakeDateField = getField(fields, "Intake date");
  const intakeWeekField = getField(fields, "Intake week");
  const completedDateField = getField(fields, "Completed date");
  const completedWeekField = getField(fields, "Completed week");
  const completedSourceField = getField(fields, "Completed source");

  let effectiveIntakeDate = itemFields["Intake date"] ?? "";
  if (
    isEmptyValue(effectiveIntakeDate) &&
    supportsFieldType(intakeDateField, "DATE") &&
    !isEmptyValue(item.createdAt)
  ) {
    effectiveIntakeDate = toDateOnly(item.createdAt);
    updates.push(makeUpdate(item, intakeDateField, "date", effectiveIntakeDate));
  }

  if (
    isEmptyValue(itemFields["Intake week"]) &&
    supportsFieldType(intakeWeekField, "TEXT") &&
    !isEmptyValue(effectiveIntakeDate)
  ) {
    updates.push(
      makeUpdate(item, intakeWeekField, "text", isoWeekString(effectiveIntakeDate)),
    );
  }

  let effectiveCompletedDate = itemFields["Completed date"] ?? "";
  let completedSource = null;

  if (
    isEmptyValue(effectiveCompletedDate) &&
    supportsFieldType(completedDateField, "DATE")
  ) {
    if (!isEmptyValue(item.closedAt)) {
      completedSource = "closedAt";
      effectiveCompletedDate = toDateOnly(item.closedAt);
    } else if (isDoneStatus(itemFields.Status, doneValues)) {
      completedSource = "project-done-observed";
      effectiveCompletedDate = today;
    }

    if (!isEmptyValue(effectiveCompletedDate)) {
      updates.push(
        makeUpdate(item, completedDateField, "date", effectiveCompletedDate, {
          source: completedSource,
        }),
      );

      if (
        completedSource &&
        isEmptyValue(itemFields["Completed source"]) &&
        supportsFieldType(completedSourceField, "SINGLE_SELECT") &&
        completedSourceOptions?.[completedSource]
      ) {
        updates.push(
          makeUpdate(
            item,
            completedSourceField,
            "singleSelect",
            completedSource,
            {
              optionId: completedSourceOptions[completedSource],
            },
          ),
        );
      }
    }
  }

  if (
    isEmptyValue(itemFields["Completed week"]) &&
    supportsFieldType(completedWeekField, "TEXT") &&
    !isEmptyValue(effectiveCompletedDate)
  ) {
    updates.push(
      makeUpdate(
        item,
        completedWeekField,
        "text",
        isoWeekString(effectiveCompletedDate),
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

function getField(fields, name) {
  if (!fields) {
    return null;
  }

  if (fields instanceof Map) {
    return fields.get(name) ?? null;
  }

  return fields[name] ?? null;
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
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
    const fieldName = fieldValue?.field?.name;
    if (!fieldName) {
      continue;
    }

    if (Object.hasOwn(fieldValue, "date")) {
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
    contentType: item.content?.__typename ?? item.type ?? "",
    contentUrl: item.content?.url ?? "",
    closedAt: item.content?.closedAt ?? "",
    fields: fieldValues,
  };
}

function validateFields(fieldsByName, warn) {
  const errors = [];

  for (const fieldName of REQUIRED_FIELDS) {
    const field = fieldsByName.get(fieldName);
    if (!field) {
      errors.push(`Required field "${fieldName}" is missing.`);
    } else if (field.dataType !== "DATE") {
      errors.push(
        `Required field "${fieldName}" must be DATE, found ${field.dataType}.`,
      );
    }
  }

  for (const fieldName of OPTIONAL_FIELDS) {
    if (!fieldsByName.has(fieldName)) {
      warn(`Optional field "${fieldName}" is missing; skipping related updates.`);
    }
  }

  warnIfWrongOptionalType(fieldsByName, "Intake week", "TEXT", warn);
  warnIfWrongOptionalType(fieldsByName, "Completed week", "TEXT", warn);
  warnIfWrongOptionalType(
    fieldsByName,
    "Completed source",
    "SINGLE_SELECT",
    warn,
  );

  if (errors.length > 0) {
    throw new Error(`Project field validation failed:\n- ${errors.join("\n- ")}`);
  }
}

function warnIfWrongOptionalType(fieldsByName, fieldName, expectedType, warn) {
  const field = fieldsByName.get(fieldName);
  if (field && field.dataType !== expectedType) {
    warn(
      `Optional field "${fieldName}" must be ${expectedType}, found ${field.dataType}; skipping related updates.`,
    );
  }
}

function getCompletedSourceOptions(fieldsByName, warn) {
  const field = fieldsByName.get("Completed source");
  if (!field || field.dataType !== "SINGLE_SELECT") {
    return null;
  }

  const optionsByName = new Map(
    (field.options ?? []).map((option) => [option.name, option.id]),
  );
  const missing = COMPLETED_SOURCE_OPTIONS.filter(
    (optionName) => !optionsByName.has(optionName),
  );

  if (missing.length > 0) {
    warn(
      `Optional field "Completed source" is missing options ${missing
        .map((name) => `"${name}"`)
        .join(", ")}; skipping source updates.`,
    );
    return null;
  }

  return Object.fromEntries(
    COMPLETED_SOURCE_OPTIONS.map((optionName) => [
      optionName,
      optionsByName.get(optionName),
    ]),
  );
}

function executeUpdate(projectId, update) {
  if (update.type === "date") {
    graphql(UPDATE_DATE_MUTATION, {
      projectId,
      itemId: update.itemId,
      fieldId: update.fieldId,
      date: update.value,
    });
    return;
  }

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
  const source = update.fieldName === "Completed date" && update.source
    ? ` source=${update.source}`
    : "";
  return `[${update.itemId}] Set "${update.fieldName}" = ${update.value}${source}`;
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function readConfig() {
  if (!process.env.GH_TOKEN || process.env.GH_TOKEN.trim() === "") {
    throw new Error(
      "GH_TOKEN is required. In GitHub Actions set GH_TOKEN=${{ secrets.PROJECTS_TOKEN }}; locally use a token with project scope.",
    );
  }

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
    doneValues: parseDoneStatusValues(process.env.DONE_STATUS_VALUES),
    today: todayUtcDate(),
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

  const completedSourceOptions = getCompletedSourceOptions(fieldsByName, warn);
  const items = fetchProjectItems(config.org, config.projectNumber);
  const plannedUpdates = items.flatMap((item) =>
    buildPlannedUpdates(item, fieldsByName, {
      today: config.today,
      doneValues: config.doneValues,
      completedSourceOptions,
    }),
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
