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

test("单商品发布使用同步接口并透传素材内容", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        success: true,
        message: "发布成功",
        data: {
          item_id: "item-1",
          item_url: "https://www.goofish.com/item?id=item-1",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const client = new XianyuClient({
      baseUrl: "https://xianyu.example",
      apiKey: "test-key",
    });
    const result = await client.publishSingle({
      accountId: "account-a",
      title: "单品标题",
      description: "单品简介",
      price: 2,
      images: ["https://images.example/1.jpg"],
      category: "虚拟商品",
      deliveryMethod: "express",
      postage: 0,
      condition: "全新",
    });
    assert.equal(result.item_id, "item-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestUrl,
    "https://xianyu.example/api/v1/product-publish/publish/single",
  );
  assert.deepEqual(requestBody, {
    account_id: "account-a",
    title: "单品标题",
    description: "单品简介",
    price: 2,
    images: ["https://images.example/1.jpg"],
    category: "虚拟商品",
    delivery_method: "express",
    postage: 0,
    condition: "全新",
  });
});
