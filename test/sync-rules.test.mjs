import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlannedUpdates,
  toDateOnly,
  validateGithubToken,
  validateOrgName,
} from "../scripts/sync-project-dates.mjs";

const allFields = new Map([
  ["Opened week", { id: "field-opened-week", name: "Opened week", dataType: "TEXT" }],
  ["Completed week", { id: "field-completed-week", name: "Completed week", dataType: "TEXT" }],
]);

const legacyFields = new Map([
  ["Intake week", { id: "field-intake-week", name: "Intake week", dataType: "TEXT" }],
  ["Completed week", { id: "field-completed-week", name: "Completed week", dataType: "TEXT" }],
]);

function item(overrides = {}) {
  return {
    id: "item-1",
    createdAt: "2026-05-12T10:15:00Z",
    openedAt: "2026-05-12T10:15:00Z",
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
  assert.equal(toDateOnly("2026-05-12"), "2026-05-12");
});

test("fills Opened week from built-in Created field", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { Created: "2026-05-12T10:15:00Z" } }),
    allFields,
  );

  assert.deepEqual(updateFor(updates, "Opened week"), {
    itemId: "item-1",
    contentUrl: "https://github.com/taskcluster/example/issues/1",
    fieldId: "field-opened-week",
    fieldName: "Opened week",
    type: "text",
    value: "2026-W20",
  });
});

test("falls back to content openedAt for Opened week", () => {
  const updates = buildPlannedUpdates(
    item({
      openedAt: "2026-05-11T23:59:00Z",
      fields: {},
    }),
    allFields,
  );

  assert.equal(updateFor(updates, "Opened week").value, "2026-W20");
});

test("supports legacy Intake week field", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { Created: "2026-05-12T10:15:00Z" } }),
    legacyFields,
  );

  assert.deepEqual(updateFor(updates, "Intake week"), {
    itemId: "item-1",
    contentUrl: "https://github.com/taskcluster/example/issues/1",
    fieldId: "field-intake-week",
    fieldName: "Intake week",
    type: "text",
    value: "2026-W20",
  });
});

test("does not overwrite Opened week", () => {
  const updates = buildPlannedUpdates(
    item({
      fields: {
        Created: "2026-05-12T10:15:00Z",
        "Opened week": "2026-W19",
      },
    }),
    allFields,
  );

  assert.equal(updateFor(updates, "Opened week"), undefined);
});

test("fills Completed week from built-in Closed field", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { Closed: "2026-05-10T08:30:00Z" } }),
    allFields,
  );

  assert.equal(updateFor(updates, "Completed week").value, "2026-W19");
});

test("falls back to content closedAt for Completed week", () => {
  const updates = buildPlannedUpdates(
    item({ closedAt: "2026-05-10T08:30:00Z" }),
    allFields,
  );

  assert.equal(updateFor(updates, "Completed week").value, "2026-W19");
});

test("does not synthesize Completed week from project Done status", () => {
  const updates = buildPlannedUpdates(
    item({ fields: { Status: "Done" } }),
    allFields,
  );

  assert.equal(updateFor(updates, "Completed week"), undefined);
});

test("does not overwrite Completed week", () => {
  const updates = buildPlannedUpdates(
    item({
      fields: {
        Closed: "2026-05-10T08:30:00Z",
        "Completed week": "2026-W18",
      },
    }),
    allFields,
  );

  assert.equal(updateFor(updates, "Completed week"), undefined);
});

test("only plans week field updates", () => {
  const updates = buildPlannedUpdates(
    item({
      fields: {
        Created: "2026-05-12T10:15:00Z",
        Closed: "2026-05-10T08:30:00Z",
      },
    }),
    allFields,
  );

  assert.deepEqual(
    updates.map((update) => update.fieldName),
    ["Opened week", "Completed week"],
  );
});

test("handles missing content", () => {
  const updates = buildPlannedUpdates(item({ contentUrl: "", closedAt: "" }), allFields);

  assert.equal(updateFor(updates, "Opened week").value, "2026-W20");
  assert.equal(updateFor(updates, "Completed week"), undefined);
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
