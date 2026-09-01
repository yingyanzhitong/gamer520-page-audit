import assert from "node:assert/strict";
import test from "node:test";

import {
  composeGameDescription,
  fetchSourceUpdateTimes,
  isSourceTimestampCurrent,
  validateImageUrl,
} from "../src/playwright-extractor.mjs";

test("虚拟机说明置于游戏描述首行且不会重复", () => {
  const virtualMachineDescription = "游戏方式:简单虚拟机化 已内置教程";
  assert.equal(
    composeGameDescription("普通游戏简介", virtualMachineDescription),
    `${virtualMachineDescription}\n普通游戏简介`,
  );
  assert.equal(
    composeGameDescription(
      `普通游戏简介\n${virtualMachineDescription}`,
      virtualMachineDescription,
    ),
    `${virtualMachineDescription}\n普通游戏简介`,
  );
});

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

test("图片链接必须返回可访问的图片内容", async () => {
  let requestOptions;
  const context = {
    request: {
      async get(url, options) {
        requestOptions = options;
        if (url.endsWith("missing.jpg")) {
          return {
            ok: () => false,
            headers: () => ({ "content-type": "text/html" }),
          };
        }
        return {
          ok: () => true,
          headers: () => ({ "content-type": "image/webp" }),
        };
      },
    },
  };
  const config = { navigationTimeoutMs: 30_000 };

  assert.equal(
    await validateImageUrl(
      context,
      "https://images.example/cover.webp",
      "https://www.gamer520.com/118842.html",
      config,
    ),
    true,
  );
  assert.equal(
    requestOptions.headers.referer,
    "https://www.gamer520.com/118842.html",
  );
  assert.equal(
    await validateImageUrl(
      context,
      "https://images.example/missing.jpg",
      "https://www.gamer520.com/118842.html",
      config,
    ),
    false,
  );
});
