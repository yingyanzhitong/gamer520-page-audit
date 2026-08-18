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

test("素材库查询按 1000 条分页读取全部素材", async () => {
  const originalFetch = globalThis.fetch;
  const requestUrls = [];
  globalThis.fetch = async (url) => {
    requestUrls.push(String(url));
    const page = new URL(String(url)).searchParams.get("page");
    const payload =
      page === "1"
        ? {
            success: true,
            data: {
              list: [{ id: 1, source_item_id: "101" }],
              total_pages: 2,
            },
          }
        : {
            success: true,
            data: {
              list: [{ id: 2, source_item_id: "102" }],
              total_pages: 2,
            },
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new XianyuClient({
      baseUrl: "https://xianyu.example",
      apiKey: "test-key",
    });
    assert.deepEqual(await client.listMaterials(), [
      { id: 1, source_item_id: "101" },
      { id: 2, source_item_id: "102" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestUrls, [
    "https://xianyu.example/api/v1/product-publish/materials?page=1&page_size=1000",
    "https://xianyu.example/api/v1/product-publish/materials?page=2&page_size=1000",
  ]);
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

test("批量发布统一使用按账号自动分流接口", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body });
    return new Response(
      JSON.stringify({
        success: true,
        data: options.method === "POST" ? { batch_id: "batch-1" } : { done: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new XianyuClient({
      baseUrl: "https://xianyu.example",
      apiKey: "test-key",
    });
    assert.deepEqual(
      await client.publishBatch({
        accountId: "account-a",
        materialIds: [1, 2],
        requestId: "request-1",
      }),
      { batch_id: "batch-1" },
    );
    assert.deepEqual(await client.getBatchStatus("batch-1"), {
      done: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requests[0].url,
    "https://xianyu.example/api/v1/product-publish/publish/batch",
  );
  assert.deepEqual(JSON.parse(requests[0].body), {
    account_ids: ["account-a"],
    material_ids: [1, 2],
    request_id: "request-1",
  });
  assert.equal(
    requests[1].url,
    "https://xianyu.example/api/v1/product-publish/publish/batch/batch-1/status",
  );
});

test("按账号读取发布能力并按该账号推荐商品分类", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    const capability = String(url).endsWith("/publish/capability");
    return new Response(
      JSON.stringify({
        success: true,
        data: capability
          ? {
              account_type: "fish-shop",
              supports: { quantity: true },
            }
          : {
              candidates: [
                {
                  cat_id: "500000",
                  channel_cat_id: "500001",
                  tb_cat_id: "500002",
                },
              ],
            },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new XianyuClient({
      baseUrl: "https://xianyu.example",
      apiKey: "test-key",
    });
    assert.deepEqual(
      await client.getAccountPublishCapability("account-a"),
      { account_type: "fish-shop", supports: { quantity: true } },
    );
    assert.deepEqual(
      await client.recommendCategory({
        accountId: "account-a",
        title: "游戏标题",
        description: "游戏简介",
      }),
      {
        candidates: [
          {
            cat_id: "500000",
            channel_cat_id: "500001",
            tb_cat_id: "500002",
          },
        ],
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    {
      url: "https://xianyu.example/api/v1/product-publish/publish/capability",
      body: { account_id: "account-a" },
    },
    {
      url: "https://xianyu.example/api/v1/product-publish/category/recommend",
      body: {
        account_id: "account-a",
        title: "游戏标题",
        description: "游戏简介",
      },
    },
  ]);
});

test("外部终止信号会取消正在进行的闲鱼请求", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestSignal;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });
  };

  try {
    const client = new XianyuClient({
      baseUrl: "https://xianyu.example",
      apiKey: "test-key",
    });
    const request = client.listAccounts({
      signal: controller.signal,
    });
    controller.abort(new Error("测试终止"));
    await assert.rejects(request, /测试终止/);
    assert.equal(requestSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
