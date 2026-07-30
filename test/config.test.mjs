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

test("批量发布使用固定轮询和超时边界", () => {
  const defaults = loadConfig();
  assert.equal(defaults.syncPollIntervalMs, 10_000);
  assert.equal(defaults.syncBatchTimeoutMs, 2 * 60 * 60 * 1_000);
  assert.equal(
    loadConfig({ syncPollIntervalMs: 10 }).syncPollIntervalMs,
    1_000,
  );
  assert.equal(
    loadConfig({ syncBatchTimeoutMs: 10 }).syncBatchTimeoutMs,
    60_000,
  );
});
