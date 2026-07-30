import assert from "node:assert/strict";
import test from "node:test";

import { XianyuClient } from "../src/xianyu-client.mjs";

test("刷新账号商品使用闲鱼允许的每页 20 条", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new XianyuClient({
      baseUrl: "https://xianyu.example",
      apiKey: "test-key",
    });
    await client.refreshAccountItems("account-a");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestBody, {
    cookie_id: "account-a",
    page_size: 20,
  });
});
