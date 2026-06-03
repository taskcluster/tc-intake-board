import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlannedUpdates,
  classifyPullRequest,
} from "../scripts/sync-project-dates.mjs";

const NOW = new Date("2026-06-03T00:00:00Z");
const RECENT = "2026-06-02T00:00:00Z";
const OLD = "2026-05-20T00:00:00Z"; // 14 days before NOW

function pr(overrides = {}) {
  return {
    title: "Add feature",
    isDraft: false,
    closed: false,
    merged: false,
    updatedAt: RECENT,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    bodyText: "",
    labelNames: [],
    reviewRequestCount: 0,
    unresolvedThreadCount: 0,
    ciState: null,
    ...overrides,
  };
}

test("draft PR is draft-or-not-ready", () => {
  assert.equal(
    classifyPullRequest(pr({ isDraft: true }), { now: NOW }),
    "pr-draft-or-not-ready",
  );
});

test("WIP in title is draft-or-not-ready", () => {
  assert.equal(
    classifyPullRequest(pr({ title: "WIP: still working" }), { now: NOW }),
    "pr-draft-or-not-ready",
  );
});

test("changes requested needs author action", () => {
  assert.equal(
    classifyPullRequest(pr({ reviewDecision: "CHANGES_REQUESTED" }), { now: NOW }),
    "pr-author-action-needed",
  );
});

test("failing CI needs author action", () => {
  assert.equal(
    classifyPullRequest(pr({ ciState: "FAILURE" }), { now: NOW }),
    "pr-author-action-needed",
  );
  assert.equal(
    classifyPullRequest(pr({ ciState: "ERROR" }), { now: NOW }),
    "pr-author-action-needed",
  );
});

test("unresolved threads need author action", () => {
  assert.equal(
    classifyPullRequest(pr({ unresolvedThreadCount: 2 }), { now: NOW }),
    "pr-author-action-needed",
  );
});

test("approved + green + mergeable is ready to merge", () => {
  assert.equal(
    classifyPullRequest(
      pr({ reviewDecision: "APPROVED", ciState: "SUCCESS" }),
      { now: NOW },
    ),
    "pr-ready-to-merge",
  );
});

test("approved with no CI configured is still ready to merge", () => {
  assert.equal(
    classifyPullRequest(
      pr({ reviewDecision: "APPROVED", ciState: null }),
      { now: NOW },
    ),
    "pr-ready-to-merge",
  );
});

test("approved but conflicting is not ready to merge", () => {
  assert.notEqual(
    classifyPullRequest(
      pr({ reviewDecision: "APPROVED", mergeable: "CONFLICTING", ciState: "SUCCESS" }),
      { now: NOW },
    ),
    "pr-ready-to-merge",
  );
});

test("review required is review-pending", () => {
  assert.equal(
    classifyPullRequest(pr({ reviewDecision: "REVIEW_REQUIRED" }), { now: NOW }),
    "pr-review-pending",
  );
});

test("pending review requests is review-pending", () => {
  assert.equal(
    classifyPullRequest(pr({ reviewRequestCount: 1 }), { now: NOW }),
    "pr-review-pending",
  );
});

test("depends on #N in body is blocked", () => {
  assert.equal(
    classifyPullRequest(pr({ bodyText: "This depends on #5 landing first." }), {
      now: NOW,
    }),
    "pr-blocked",
  );
});

test("blocked label is blocked", () => {
  assert.equal(
    classifyPullRequest(pr({ labelNames: ["blocked"] }), { now: NOW }),
    "pr-blocked",
  );
});

test("blocked by: in body is blocked", () => {
  assert.equal(
    classifyPullRequest(pr({ bodyText: "Blocked by: upstream release" }), {
      now: NOW,
    }),
    "pr-blocked",
  );
});

test("prose mentioning dependency without marker is not blocked", () => {
  assert.equal(
    classifyPullRequest(
      pr({ bodyText: "This change is independent of other work." }),
      { now: NOW },
    ),
    "pr-review-pending",
  );
});

test("old PR with no reviewers is stale", () => {
  assert.equal(
    classifyPullRequest(pr({ updatedAt: OLD }), { now: NOW }),
    "pr-stale",
  );
});

test("review-pending outranks stale", () => {
  assert.equal(
    classifyPullRequest(
      pr({ updatedAt: OLD, reviewDecision: "REVIEW_REQUIRED" }),
      { now: NOW },
    ),
    "pr-review-pending",
  );
});

test("blocked overrides stale", () => {
  assert.equal(
    classifyPullRequest(pr({ updatedAt: OLD, labelNames: ["blocked"] }), {
      now: NOW,
    }),
    "pr-blocked",
  );
});

test("author action outranks draft", () => {
  assert.equal(
    classifyPullRequest(
      pr({ isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
      { now: NOW },
    ),
    "pr-author-action-needed",
  );
});

test("author action outranks blocked", () => {
  assert.equal(
    classifyPullRequest(
      pr({ labelNames: ["blocked"], reviewDecision: "CHANGES_REQUESTED" }),
      { now: NOW },
    ),
    "pr-author-action-needed",
  );
});

test("open non-draft recent PR with nothing else defaults to review-pending", () => {
  assert.equal(classifyPullRequest(pr(), { now: NOW }), "pr-review-pending");
});

test("closed PR is not classified", () => {
  assert.equal(classifyPullRequest(pr({ closed: true }), { now: NOW }), null);
});

test("merged PR is not classified", () => {
  assert.equal(classifyPullRequest(pr({ merged: true }), { now: NOW }), null);
});

test("null pr is not classified", () => {
  assert.equal(classifyPullRequest(null, { now: NOW }), null);
});

// --- buildPlannedUpdates integration with the lifecycle field ---

const lifecycleField = {
  id: "field-lifecycle",
  name: "PR lifecycle",
  dataType: "SINGLE_SELECT",
  options: [
    { id: "opt-author", name: "pr-author-action-needed" },
    { id: "opt-blocked", name: "pr-blocked" },
    { id: "opt-ready", name: "pr-ready-to-merge" },
    { id: "opt-review", name: "pr-review-pending" },
    { id: "opt-stale", name: "pr-stale" },
    { id: "opt-draft", name: "pr-draft-or-not-ready" },
  ],
};

const fieldsWithLifecycle = new Map([["PR lifecycle", lifecycleField]]);

function prItem(overrides = {}) {
  return {
    id: "item-pr",
    createdAt: "2026-05-12T10:15:00Z",
    contentUrl: "https://github.com/taskcluster/example/pull/1",
    fields: {},
    pullRequest: pr({ reviewDecision: "CHANGES_REQUESTED" }),
    ...overrides,
  };
}

test("plans a single-select update for an open PR", () => {
  const updates = buildPlannedUpdates(prItem(), fieldsWithLifecycle);
  const lifecycle = updates.find((u) => u.fieldName === "PR lifecycle");
  assert.ok(lifecycle);
  assert.equal(lifecycle.type, "singleSelect");
  assert.equal(lifecycle.value, "pr-author-action-needed");
  assert.equal(lifecycle.optionId, "opt-author");
});

test("does not re-plan when the current label already matches", () => {
  const updates = buildPlannedUpdates(
    prItem({ fields: { "PR lifecycle": "pr-author-action-needed" } }),
    fieldsWithLifecycle,
  );
  assert.equal(
    updates.find((u) => u.fieldName === "PR lifecycle"),
    undefined,
  );
});

test("re-plans when the current label is stale", () => {
  const updates = buildPlannedUpdates(
    prItem({ fields: { "PR lifecycle": "pr-review-pending" } }),
    fieldsWithLifecycle,
  );
  const lifecycle = updates.find((u) => u.fieldName === "PR lifecycle");
  assert.ok(lifecycle);
  assert.equal(lifecycle.value, "pr-author-action-needed");
});

test("non-PR items get no lifecycle update", () => {
  const updates = buildPlannedUpdates(
    { id: "item-issue", fields: {}, pullRequest: null },
    fieldsWithLifecycle,
  );
  assert.equal(updates.length, 0);
});

test("missing lifecycle field yields no lifecycle update", () => {
  const updates = buildPlannedUpdates(prItem(), new Map());
  assert.equal(updates.length, 0);
});
