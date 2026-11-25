// A copy's date: the original's local time with its offset (utils/photo-time.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { localDateWithOffset } from "../src/utils/photo-time.ts";

test("the local time with the photo's own offset, as Immich's date editor sends it", () => {
  assert.equal(localDateWithOffset("2023-11-04T20:30:00+00:00", "2023-11-05T02:00:00.000Z"), "2023-11-05T02:00:00.000+05:30");
  assert.equal(localDateWithOffset("2022-01-01T07:30:00+00:00", "2022-01-01T08:30:00.000Z"), "2022-01-01T08:30:00.000+01:00");
  assert.equal(localDateWithOffset("2024-07-04T23:00:00.000Z", "2024-07-04T19:00:00.000Z"), "2024-07-04T19:00:00.000-04:00");
  assert.equal(localDateWithOffset("2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"), "2024-01-01T00:00:00.000+00:00");
});

test("without a usable local time, the date as Immich gave it", () => {
  assert.equal(localDateWithOffset("2024-05-01T10:00:00.000Z", null), "2024-05-01T10:00:00.000Z");
  assert.equal(localDateWithOffset("2024-05-01T10:00:00.000Z", "not a date"), "2024-05-01T10:00:00.000Z");
  assert.equal(localDateWithOffset("2024-05-01T10:00:00.000Z", "2024-05-03T10:00:00.000Z"), "2024-05-01T10:00:00.000Z");
});
