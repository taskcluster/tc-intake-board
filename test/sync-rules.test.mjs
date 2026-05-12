import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlannedUpdates,
  isDoneStatus,
  parseDoneStatusValues,
  toDateOnly,
  validateGithubToken,
  validateOrgName,
} from "../scripts/sync-project-dates.mjs";

const allFields = new Map([
  ["Intake date", { id: "field-intake-date", name: "Intake date", dataType: "DATE" }],
  ["Completed date", { id: "field-completed-date", name: "Completed date", dataType: "DATE" }],
  ["Intake week", { id: "field-intake-week", name: "Intake week", dataType: "TEXT" }],
  ["Completed week", { id: "field-completed-week", name: "Completed week", dataType: "TEXT" }],
  [
    "Completed source",
    {
      id: "field-completed-source",
      name: "Completed source",
      dataType: "SINGLE_SELECT",
    },
  ],
]);

const requiredFieldsOnly = new Map([
  ["Intake date", { id: "field-intake-date", name: "Intake date", dataType: "DATE" }],
  ["Completed date", { id: "field-completed-date", name: "Completed date", dataType: "DATE" }],
]);

const defaultOptions = {
  today: "2026-05-12",
  doneValues: parseDoneStatusValues(),
  completedSourceOptions: {
    closedAt: "option-closed-at",
    "project-done-observed": "option-done-observed",
    manual: "option-manual",
  },
};

function item(overrides = {}) {
  return {
    id: "item-1",
    createdAt: "2026-05-12T10:15:00Z",
    contentUrl: "https://github.com/taskcluster/example/issues/1",
    closedAt: "",
    fields: {},
    ...overrides,
  };
}

function updateFor(updates, fieldName) {
  return updates.find((update) => update.fieldName === fieldName);
}

test("converts timestamps to UTC date-only values", () => {
  assert.equal(toDateOnly("2026-05-12T23:59:59Z"), "2026-05-12");
  assert.equal(toDateOnly("2026-05-12T23:30:00-02:00"), "2026-05-13");
});

test("fills Intake date from item createdAt if missing", () => {
  const updates = buildPlannedUpdates(item(), allFields, defaultOptions);

  assert.deepEqual(updateFor(updates, "Intake date"), {
    itemId: "item-1",
    contentUrl: "https://github.com/taskcluster/example/issues/1",
    fieldId: "field-intake-date",
    fieldName: "Intake date",
    type: "date",
    value: "2026-05-12",
  });
});

test("does not overwrite Intake date", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { "Intake date": "2026-05-01" } }),
    allFields,
    defaultOptions,
  );

  assert.equal(updateFor(updates, "Intake date"), undefined);
});

test("fills Intake week from Intake date", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { "Intake date": "2026-05-12" } }),
    allFields,
    defaultOptions,
  );

  assert.equal(updateFor(updates, "Intake week").value, "2026-W20");
});

test("fills Completed date from closedAt if missing", () => {
  const updates = buildPlannedUpdates(
    item({ closedAt: "2026-05-10T08:30:00Z" }),
    allFields,
    defaultOptions,
  );

  assert.deepEqual(updateFor(updates, "Completed date"), {
    itemId: "item-1",
    contentUrl: "https://github.com/taskcluster/example/issues/1",
    fieldId: "field-completed-date",
    fieldName: "Completed date",
    type: "date",
    value: "2026-05-10",
    source: "closedAt",
  });
  assert.equal(updateFor(updates, "Completed source").value, "closedAt");
  assert.equal(updateFor(updates, "Completed source").optionId, "option-closed-at");
});

test("uses project Done status only when closedAt is missing", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { Status: "Done" } }),
    allFields,
    defaultOptions,
  );

  assert.equal(updateFor(updates, "Completed date").value, "2026-05-12");
  assert.equal(updateFor(updates, "Completed date").source, "project-done-observed");
  assert.equal(updateFor(updates, "Completed source").value, "project-done-observed");

  const closedUpdates = buildPlannedUpdates(
    item({
      closedAt: "2026-05-09T00:00:00Z",
      fields: { Status: "Done" },
    }),
    allFields,
    defaultOptions,
  );
  assert.equal(updateFor(closedUpdates, "Completed date").value, "2026-05-09");
  assert.equal(updateFor(closedUpdates, "Completed date").source, "closedAt");
});

test("does not overwrite Completed date", () => {
  const updates = buildPlannedUpdates(
    item({
      closedAt: "2026-05-10T08:30:00Z",
      fields: {
        "Completed date": "2026-05-01",
        "Completed week": "2026-W18",
      },
    }),
    allFields,
    defaultOptions,
  );

  assert.equal(updateFor(updates, "Completed date"), undefined);
});

test("fills Completed week from effective Completed date", () => {
  const updates = buildPlannedUpdates(
    item({ closedAt: "2026-05-10T08:30:00Z" }),
    allFields,
    defaultOptions,
  );

  assert.equal(updateFor(updates, "Completed week").value, "2026-W19");
});

test("handles missing optional week fields", () => {
  const updates = buildPlannedUpdates(
    item({
      closedAt: "2026-05-10T08:30:00Z",
      fields: { Status: "Done" },
    }),
    requiredFieldsOnly,
    defaultOptions,
  );

  assert.deepEqual(
    updates.map((update) => update.fieldName),
    ["Intake date", "Completed date"],
  );
});

test("handles missing content", () => {
  const updates = buildPlannedUpdates(item({ contentUrl: "", closedAt: "" }), allFields, defaultOptions);

  assert.equal(updateFor(updates, "Intake date").value, "2026-05-12");
  assert.equal(updateFor(updates, "Completed date"), undefined);
});

test("detects done statuses case-insensitively", () => {
  const doneValues = parseDoneStatusValues("Done,Closed");

  assert.equal(isDoneStatus("done", doneValues), true);
  assert.equal(isDoneStatus(" CLOSED ", doneValues), true);
  assert.equal(isDoneStatus("in progress", doneValues), false);
});

test("validates GitHub organization login format", () => {
  assert.doesNotThrow(() => validateOrgName("taskcluster"));
  assert.doesNotThrow(() => validateOrgName("taskcluster-ci_2"));
  assert.throws(() => validateOrgName("taskcluster/example"), /ORG must be/);
  assert.throws(() => validateOrgName(""), /ORG must be/);
});

test("validates GitHub token format before invoking gh", () => {
  assert.doesNotThrow(() => validateGithubToken("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert.doesNotThrow(() => validateGithubToken("github_pat_abcdefghijklmnopqrstuvwxyz"));
  assert.throws(() => validateGithubToken(""), /GH_TOKEN is required/);
  assert.throws(() => validateGithubToken("ghp_abc\n"), /raw GitHub token only/);
  assert.throws(() => validateGithubToken(" token ghp_abc"), /raw GitHub token only/);
  assert.throws(() => validateGithubToken("Bearer ghp_abc"), /raw GitHub token only/);
});
