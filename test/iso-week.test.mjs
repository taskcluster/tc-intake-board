import assert from "node:assert/strict";
import { test } from "node:test";

import { isoWeekString } from "../scripts/sync-project-dates.mjs";

test("formats ISO weeks with ISO week-years", () => {
  assert.equal(isoWeekString("2026-01-01"), "2026-W01");
  assert.equal(isoWeekString("2026-05-12"), "2026-W20");
  assert.equal(isoWeekString("2021-01-01"), "2020-W53");
  assert.equal(isoWeekString("2020-12-31"), "2020-W53");
  assert.equal(isoWeekString("2022-01-01"), "2021-W52");
});

test("rejects invalid date-only strings", () => {
  assert.throws(() => isoWeekString("2026-5-12"), /Invalid date-only/);
  assert.throws(() => isoWeekString("2026-02-31"), /Invalid date-only/);
});
