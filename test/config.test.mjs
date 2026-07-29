import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

test("采集页数最多为前 50 页", () => {
  assert.equal(loadConfig({ pageCount: 50 }).pageCount, 50);
  assert.equal(loadConfig({ pageCount: 51 }).pageCount, 50);
  assert.equal(loadConfig({ pageCount: 100 }).pageCount, 50);
});

test("允许采集少于 50 页", () => {
  assert.equal(loadConfig({ pageCount: 20 }).pageCount, 20);
});
