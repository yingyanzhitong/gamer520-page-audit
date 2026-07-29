import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSourceUpdateTimes,
  isSourceTimestampCurrent,
} from "../src/playwright-extractor.mjs";

test("来源更新时间接口批量读取 modified_gmt 并按 UTC 标准化", async () => {
  let requestedUrl;
  const context = {
    request: {
      async get(url) {
        requestedUrl = new URL(url);
        return {
          ok: () => true,
          json: async () => [
            { id: 118842, modified_gmt: "2026-07-28T03:51:00" },
            { id: 118843, modified: "2026-07-28T11:52:00+08:00" },
          ],
        };
      },
    },
  };

  const timestamps = await fetchSourceUpdateTimes(
    context,
    "https://www.gamer520.com/118842.html",
    [118842, 118843],
    { navigationTimeoutMs: 30_000 },
  );

  assert.equal(requestedUrl.pathname, "/wp-json/wp/v2/posts");
  assert.equal(requestedUrl.searchParams.get("include"), "118842,118843");
  assert.equal(requestedUrl.searchParams.get("_fields"), "id,modified_gmt,modified");
  assert.equal(timestamps.get(118842), "2026-07-28T03:51:00.000Z");
  assert.equal(timestamps.get(118843), "2026-07-28T03:52:00.000Z");
});

test("来源修改时间不晚于最后成功采集时间时可直接跳过", () => {
  assert.equal(
    isSourceTimestampCurrent(
      "2026-07-28T03:51:00.000Z",
      "2026-07-28T04:00:00.000Z",
    ),
    true,
  );
  assert.equal(
    isSourceTimestampCurrent(
      "2026-07-28T04:01:00.000Z",
      "2026-07-28T04:00:00.000Z",
    ),
    false,
  );
});
