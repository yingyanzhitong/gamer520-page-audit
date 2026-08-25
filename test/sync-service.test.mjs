import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CrawlerDatabase } from "../src/database.mjs";
import {
  publishBatchLogIntervalMs,
  publishBatchSize,
  XianyuSyncService,
} from "../src/sync-service.mjs";
import { TaskControl } from "../src/task-control.mjs";

function game(
  id,
  imageUrl = `https://images.example/${id}.jpg`,
  title = `游戏 ${id}`,
) {
  return {
    id,
    sourceUrl: `https://www.gamer520.com/${id}.html`,
    title,
    imageUrl,
    hotPage: 1,
    hotPosition: id,
    hotRank: id,
  };
}

function result(
  id,
  description = `游戏 ${id} 简介`,
  imageUrl,
  title = `游戏 ${id}`,
) {
  return {
    page: {
      url: `https://www.gamer520.com/${id}.html`,
      title,
      image: imageUrl ?? `https://images.example/${id}.jpg`,
      gameDescription: description,
    },
    resource: {
      resourceCode: `A${id}`,
      detailPageUrl: `https://gamers520.com/${id}.html`,
      archivePassword: "password",
      downloads: [
        {
          provider: "百度网盘",
          url: `https://pan.example/${id}`,
          password: "abcd",
          extractionCode: "abcd",
          qrImageUrl: null,
          qrDecodeMethod: "test",
        },
      ],
    },
  };
}

class FakeXianyuClient {
  constructor() {
    this.materials = new Map();
    this.upsertCalls = [];
    this.publishCalls = [];
    this.cardBindCalls = [];
    this.events = [];
    this.accountItems = new Map();
    this.refreshedAccountItems = new Map();
    this.refreshAccountItemCalls = [];
    this.listMaterialCalls = 0;
    this.capabilities = new Map();
  }

  async listAccounts() {
    return [
      { accountId: "account-a", enabled: true, remark: "A" },
      { accountId: "account-b", enabled: true, remark: "B" },
    ];
  }

  async upsertMaterials(items) {
    this.upsertCalls.push(items);
    this.events.push({ type: "material", count: items.length });
    return items.map((item) => {
      const previous = this.materials.get(item.external_id);
      const materialId = previous?.materialId ?? this.materials.size + 1;
      const action = !previous
        ? "created"
        : previous.contentHash === item.content_hash
          ? "unchanged"
          : "updated";
      this.materials.set(item.external_id, {
        materialId,
        contentHash: item.content_hash,
        title: item.title,
      });
      return {
        external_id: item.external_id,
        material_id: materialId,
        action,
      };
    });
  }

  async listMaterials() {
    this.listMaterialCalls += 1;
    return [...this.materials.entries()].map(([externalId, material]) => ({
      id: material.materialId,
      source_type: "gamer520",
      source_item_id: externalId,
      source_content_hash: material.contentHash,
      title: material.title,
    }));
  }

  async getAccountPublishCapability(accountId) {
    return this.capabilities.get(accountId) ?? {
      account_id: accountId,
      account_type: "personal",
      supports: {
        quantity: false,
        specifications: false,
        sku_rows: false,
        shipping_methods: ["free", "distance", "fixed", "none"],
      },
    };
  }

  async recommendCategory() {
    return {
      candidates: [
        {
          cat_id: "500000",
          cat_name: "虚拟商品",
          channel_cat_id: "500001",
          channel_cat_name: "虚拟服务",
          leaf_id: "500002",
          tb_cat_id: "500003",
          path: [{ id: "500001", name: "虚拟服务" }],
          is_selected: true,
        },
      ],
    };
  }

  async publishBatch(payload) {
    this.publishCalls.push(payload);
    this.events.push({
      type: "publish",
      count: payload.materialIds.length,
    });
    return { batch_id: payload.requestId };
  }

  async getBatchStatus(batchId) {
    const call = this.publishCalls.find(
      (item) => item.requestId === batchId,
    );
    const accountItems =
      this.accountItems.get(call.accountId) ?? [];
    for (const materialId of call.materialIds) {
      const material = [...this.materials.values()].find(
        (item) => item.materialId === materialId,
      );
      const itemId = `item-${call.accountId}-${materialId}`;
      if (!accountItems.some((item) => item.item_id === itemId)) {
        accountItems.push({
          item_id: itemId,
          item_title: material?.title ?? `商品 ${materialId}`,
        });
      }
    }
    this.accountItems.set(call.accountId, accountItems);
    return {
      done: true,
      items: call.materialIds.map((materialId) => ({
        account_id: call.accountId,
        material_id: materialId,
        status: "success",
        item_id: `item-${call.accountId}-${materialId}`,
        item_url: `https://www.goofish.com/item?id=${materialId}`,
      })),
    };
  }

  async refreshAccountItems(accountId) {
    this.refreshAccountItemCalls.push(accountId);
    return [
      ...(this.refreshedAccountItems.get(accountId) ??
        this.accountItems.get(accountId) ??
        []),
    ];
  }

  async listAccountItems(accountId) {
    return [...(this.accountItems.get(accountId) ?? [])];
  }

  async bindCards(payload) {
    this.cardBindCalls.push(payload);
    return {
      success_count: payload.itemIds.length,
      fail_count: 0,
    };
  }
}

class TrackingXianyuClient extends FakeXianyuClient {
  constructor() {
    super();
    this.activeUpserts = 0;
    this.maxActiveUpserts = 0;
  }

  async upsertMaterials(items) {
    this.activeUpserts += 1;
    this.maxActiveUpserts = Math.max(
      this.maxActiveUpserts,
      this.activeUpserts,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await super.upsertMaterials(items);
    } finally {
      this.activeUpserts -= 1;
    }
  }

}

class MaterialFailureClient extends TrackingXianyuClient {
  async upsertMaterials(items) {
    if (items[0]?.external_id === "account-a:3") {
      this.upsertCalls.push(items);
      throw new Error("测试素材同步失败");
    }
    return super.upsertMaterials(items);
  }
}

class FlakyCardClient extends FakeXianyuClient {
  constructor() {
    super();
    this.failNextCardBind = true;
  }

  async bindCards(payload) {
    this.cardBindCalls.push(payload);
    if (this.failNextCardBind) {
      this.failNextCardBind = false;
      return { success_count: 0, fail_count: 1 };
    }
    return { success_count: 1, fail_count: 0 };
  }
}

class ProbeFailureClient extends FakeXianyuClient {
  async getBatchStatus(batchId) {
    const call = this.publishCalls.find(
      (item) => item.requestId === batchId,
    );
    return {
      done: true,
      items: call.materialIds.map((materialId) => ({
        account_id: call.accountId,
        material_id: materialId,
        status: "failed",
        error_message: "可能发布失败（页面未跳转，仍停留在发布页）",
      })),
    };
  }
}

class PartialPublishFailureClient extends FakeXianyuClient {
  async getBatchStatus(batchId) {
    const call = this.publishCalls.find(
      (item) => item.requestId === batchId,
    );
    const accountItems = this.accountItems.get(call.accountId) ?? [];
    const items = call.materialIds.map((materialId) => {
      if (materialId === 1) {
        return {
          account_id: call.accountId,
          material_id: materialId,
          status: "failed",
          error_message: "测试发布失败",
        };
      }
      const material = [...this.materials.values()].find(
        (item) => item.materialId === materialId,
      );
      const itemId = `item-${call.accountId}-${materialId}`;
      if (!accountItems.some((item) => item.item_id === itemId)) {
        accountItems.push({
          item_id: itemId,
          item_title: material?.title ?? `商品 ${materialId}`,
        });
      }
      return {
        account_id: call.accountId,
        material_id: materialId,
        status: "success",
        item_id: itemId,
        item_url: `https://www.goofish.com/item?id=${materialId}`,
      };
    });
    this.accountItems.set(call.accountId, accountItems);
    return { done: true, items };
  }
}

class RejectedBatchClient extends FakeXianyuClient {
  async publishBatch(payload) {
    if (this.publishCalls.length === 0) {
      this.publishCalls.push(payload);
      this.events.push({
        type: "publish",
        count: payload.materialIds.length,
      });
      const error = new Error("当前批次参数不符合发布要求");
      error.status = 422;
      throw error;
    }
    return super.publishBatch(payload);
  }
}

class MissingItemIdBatchClient extends FakeXianyuClient {
  async getBatchStatus(batchId) {
    const call = this.publishCalls.find(
      (item) => item.requestId === batchId,
    );
    return {
      done: true,
      items: call.materialIds.map((materialId) => ({
        account_id: call.accountId,
        material_id: materialId,
        status: "success",
        item_id: null,
        item_url: null,
      })),
    };
  }
}

function config(databasePath, overrides = {}) {
  return {
    dbPath: databasePath,
    xianyuApiKey: "unused-by-fake",
    xianyuBaseUrl: "https://xianyu.example",
    publicBaseUrl: "https://gamer520.example",
    coverCacheDir: path.join(path.dirname(databasePath), "covers"),
    coverCacheEnabled: false,
    syncPollIntervalMs: 1,
    syncBatchTimeoutMs: 100,
    ...overrides,
  };
}

test("闲鱼商品核对按编号或唯一名称确认发布，未匹配项回退素材库", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-account-item-sync-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-08-05T00:00:00.000Z";
  const confirmedGame = game(301);
  const titleMatchedGame = game(302);
  const unmatchedGame = game(303);
  const ambiguousTitleGame = game(304);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames(
      [confirmedGame, titleMatchedGame, unmatchedGame, ambiguousTitleGame],
      timestamp,
    );
    database.saveGameSuccess(confirmedGame, result(confirmedGame.id), timestamp);
    database.saveGameSuccess(
      titleMatchedGame,
      result(titleMatchedGame.id),
      timestamp,
    );
    database.saveGameSuccess(unmatchedGame, result(unmatchedGame.id), timestamp);
    database.saveGameSuccess(
      ambiguousTitleGame,
      result(ambiguousTitleGame.id),
      timestamp,
    );
    database.database.prepare(`
      UPDATE games
      SET xianyu_item_id = ?
      WHERE id = ?
    `).run("item-confirmed", confirmedGame.id);
    for (const gameItem of [
      titleMatchedGame,
      unmatchedGame,
      ambiguousTitleGame,
    ]) {
      const stored = database.queryOne(
        "SELECT content_hash FROM games WHERE id = ?",
        gameItem.id,
      );
      database.markMaterialSynced(
        gameItem.id,
        "account-a",
        gameItem.id * 10,
        stored.content_hash,
        timestamp,
      );
      database.markPublicationSubmitted(
        gameItem.id,
        "account-a",
        gameItem.id * 10,
        `batch-${gameItem.id}`,
        timestamp,
      );
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  client.accountItems.set("account-a", [
    {
      item_id: "item-confirmed",
      item_url: "https://www.goofish.com/item?id=item-confirmed",
    },
    {
      item_id: "item-title-matched",
      item_title: "【秒发】游戏 302",
      item_url: "https://www.goofish.com/item?id=item-title-matched",
    },
    {
      item_id: "item-ambiguous-one",
      item_title: "【秒发】游戏 304",
    },
    {
      item_id: "item-ambiguous-two",
      item_title: "【秒发】游戏 304",
    },
  ]);
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const summary = await service.syncAccountPublishedItems();
    assert.deepEqual(summary, {
      accountId: "account-a",
      remoteMaterialCount: 0,
      materialConfirmedCount: 0,
      materialResetCount: 3,
      materialImportedCount: 0,
      accountItemCount: 4,
      localItemCount: 4,
      confirmedCount: 2,
      titleMatchedCount: 1,
      materialFallbackCount: 2,
    });
    assert.deepEqual(client.refreshAccountItemCalls, ["account-a"]);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    assert.equal(
      checkedDatabase.queryOne(
        "SELECT status FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
        confirmedGame.id,
        "account-a",
      ).status,
      "success",
    );
    assert.deepEqual(
      {
        ...checkedDatabase.queryOne(
          "SELECT status, item_id FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
          titleMatchedGame.id,
          "account-a",
        ),
      },
      { status: "success", item_id: "item-title-matched" },
    );
    assert.deepEqual(
      {
        ...checkedDatabase.queryOne(
          "SELECT status, item_id, last_error FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
          unmatchedGame.id,
          "account-a",
        ),
      },
      {
        status: "pending",
        item_id: null,
        last_error: "当前闲鱼账号未找到商品，已回退到素材库",
      },
    );
    assert.equal(
      checkedDatabase.queryOne(
        "SELECT xianyu_item_id FROM games WHERE id = ?",
        unmatchedGame.id,
      ).xianyu_item_id,
      null,
    );
    assert.equal(
      checkedDatabase.queryOne(
        "SELECT status FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
        ambiguousTitleGame.id,
        "account-a",
      ).status,
      "pending",
    );
    checkedDatabase.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("手动闲鱼商品同步按素材库和实时商品管理回写当前状态", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-current-xianyu-status-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-08-11T00:00:00.000Z";
  const materialOnlyGame = game(401);
  const productOnlyGame = game(402);
  const deletedRemoteGame = game(403);
  const database = new CrawlerDatabase(databasePath);
  let materialContentHash;
  try {
    for (const gameItem of [
      materialOnlyGame,
      productOnlyGame,
      deletedRemoteGame,
    ]) {
      database.upsertDiscoveredGames([gameItem], timestamp);
      database.saveGameSuccess(gameItem, result(gameItem.id), timestamp);
    }
    materialContentHash = database.queryOne(
      "SELECT content_hash FROM games WHERE id = ?",
      materialOnlyGame.id,
    ).content_hash;
    const deletedContentHash = database.queryOne(
      "SELECT content_hash FROM games WHERE id = ?",
      deletedRemoteGame.id,
    ).content_hash;
    database.markMaterialSynced(
      deletedRemoteGame.id,
      "account-a",
      4030,
      deletedContentHash,
      timestamp,
    );
    database.markPublicationSubmitted(
      deletedRemoteGame.id,
      "account-a",
      4030,
      "batch-403",
      timestamp,
    );
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  client.materials.set(`account-a:${materialOnlyGame.id}`, {
    materialId: 4010,
    contentHash: materialContentHash,
    title: "游戏 401",
  });
  const remoteItems = [
    {
      item_id: "item-product-only",
      item_title: "【秒发】游戏 402",
      item_url: "https://www.goofish.com/item?id=item-product-only",
    },
  ];
  client.accountItems.set("account-a", [
    ...remoteItems,
    {
      item_id: "item-offline",
      item_title: "【秒发】游戏 403",
    },
  ]);
  client.refreshedAccountItems.set("account-a", remoteItems);
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const summary = await service.syncAccountPublishedItems();
    assert.deepEqual(summary, {
      accountId: "account-a",
      remoteMaterialCount: 1,
      materialConfirmedCount: 0,
      materialResetCount: 1,
      materialImportedCount: 1,
      accountItemCount: 1,
      localItemCount: 3,
      confirmedCount: 1,
      titleMatchedCount: 1,
      materialFallbackCount: 1,
    });

    const checkedDatabase = new CrawlerDatabase(databasePath);
    assert.deepEqual(
      {
        ...checkedDatabase.queryOne(
          `SELECT material_id, status FROM xianyu_account_material_sync
           WHERE game_id = ? AND account_id = ?`,
          materialOnlyGame.id,
          "account-a",
        ),
      },
      { material_id: 4010, status: "synced" },
    );
    assert.deepEqual(
      {
        ...checkedDatabase.queryOne(
          "SELECT status, item_id FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
          productOnlyGame.id,
          "account-a",
        ),
      },
      { status: "success", item_id: "item-product-only" },
    );
    assert.deepEqual(
      {
        ...checkedDatabase.queryOne(
          `SELECT material_id, status FROM xianyu_account_material_sync
           WHERE game_id = ? AND account_id = ?`,
          deletedRemoteGame.id,
          "account-a",
        ),
      },
      { material_id: null, status: "pending" },
    );
    assert.deepEqual(
      {
        ...checkedDatabase.queryOne(
          "SELECT status, item_id FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
          deletedRemoteGame.id,
          "account-a",
        ),
      },
      { status: "pending", item_id: null },
    );
    checkedDatabase.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("素材导入和商品发布独立运行，单批数量可配置", async () => {
  assert.equal(publishBatchSize, 20);
  assert.equal(publishBatchLogIntervalMs, 60_000);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-limit-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);
  const timestamp = "2026-07-28T00:00:00.000Z";
  try {
    for (let id = 1; id <= 21; id += 1) {
      const discovered = game(id);
      const scraped = result(id, undefined, discovered.imageUrl);
      if (id === 1) {
        scraped.resource.downloads.push(
          {
            provider: "夸克网盘",
            url: "https://pan.example/quark-1",
            password: "quark",
            extractionCode: "quark",
            qrImageUrl: null,
            qrDecodeMethod: null,
          },
          {
            provider: "迅雷云盘",
            url: "https://pan.example/xunlei-1",
            password: "xunlei",
            extractionCode: "xunlei",
            qrImageUrl: null,
            qrDecodeMethod: null,
          },
        );
      }
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        scraped,
        timestamp,
      );
    }
    database.setXianyuSettings(
      "account-a",
      2.5,
      timestamp,
      null,
      null,
      null,
      { cardId: 6 },
    );
    database.setGameSalePrice(1, 9.9, timestamp);
  } finally {
    database.close();
  }

  const client = new TrackingXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  const progressEvents = [];
  try {
    const sync = await service.run({
      trigger: "test",
      materialConcurrency: 5,
      publishBatchSize: 7,
      onProgress: (progress) => progressEvents.push(progress),
    });
    assert.equal(sync.selectedCount, 21);
    assert.equal(sync.batchCount, client.publishCalls.length);
    assert.equal(client.upsertCalls.length, 21);
    assert.ok(client.publishCalls.length >= 3);
    assert.equal(client.cardBindCalls.length, 21);
    assert.equal(client.maxActiveUpserts, 5);
    assert.ok(client.upsertCalls.every((items) => items.length === 1));
    assert.ok(client.upsertCalls.every((items) => items[0].quantity === 1));
    assert.equal(
      client.publishCalls.reduce(
        (total, payload) => total + payload.materialIds.length,
        0,
      ),
      21,
    );
    assert.ok(
      client.publishCalls.every(
        (payload) =>
          payload.materialIds.length >= 1 &&
          payload.materialIds.length <= 7,
      ),
    );
    const firstPublishEvent = client.events.findIndex(
      (event) => event.type === "publish",
    );
    assert.ok(firstPublishEvent >= 0);
    assert.ok(
      client.events
        .slice(firstPublishEvent + 1)
        .some((event) => event.type === "material"),
    );
    assert.ok(
      client.cardBindCalls.every(
        (payload) =>
          payload.itemIds.length === 1 &&
          payload.cardIds.length === 1 &&
          payload.cardIds[0] === 6 &&
          payload.itemTitle.startsWith("【秒发】"),
      ),
    );
    assert.equal(progressEvents[0].total, 21);
    assert.equal(progressEvents[0].completed, 0);
    assert.equal(progressEvents.at(-1).completed, 21);
    assert.equal(progressEvents.at(-1).phase, "completed");
    assert.equal(progressEvents.at(-1).materialTotal, 21);
    assert.equal(progressEvents.at(-1).materialCompleted, 21);
    assert.equal(progressEvents.at(-1).publishTotal, 21);
    assert.equal(progressEvents.at(-1).publishCompleted, 21);
    for (const item of client.upsertCalls.flat()) {
      assert.deepEqual(item.images, [
        `https://images.example/${item.external_id.split(":").at(-1)}.jpg`,
      ]);
      assert.equal(
        item.price,
        item.external_id === "account-a:1" ? 9.9 : 2.5,
      );
      assert.match(item.title, /^【秒发】/);
      assert.match(item.description, /虚拟商品24小时自动发货/);
      assert.match(item.description, /喜欢直接拍，有问题随时聊/);
    }
    assert.match(
      client.upsertCalls.flat()[0].description,
      /支持网盘：百度\/夸克\/迅雷/,
    );
    const checkedDatabase = new CrawlerDatabase(databasePath);
    const storedRun = checkedDatabase.queryOne(
      `SELECT
         id,
         selected_count,
         processed_count,
         current_game_id,
         current_title,
         card_bound,
         card_bind_failed,
         material_failed,
         material_processed_count,
         publish_selected_count,
         publish_processed_count,
         batch_count,
         requested_limit
       FROM xianyu_sync_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
    const operationLogs = checkedDatabase.listTaskOperationLogs({
      taskType: "sync",
      runId: storedRun.id,
      limit: 10_000,
    });
    checkedDatabase.close();
    assert.equal(storedRun.selected_count, 21);
    assert.equal(storedRun.processed_count, 21);
    assert.equal(storedRun.current_game_id, null);
    assert.equal(storedRun.current_title, null);
    assert.equal(storedRun.card_bound, 21);
    assert.equal(storedRun.card_bind_failed, 0);
    assert.equal(storedRun.material_failed, 0);
    assert.equal(storedRun.material_processed_count, 21);
    assert.equal(storedRun.publish_selected_count, 21);
    assert.equal(storedRun.publish_processed_count, 21);
    assert.equal(storedRun.batch_count, client.publishCalls.length);
    assert.equal(storedRun.requested_limit, 7);
    assert.ok(operationLogs.length > 21);
    assert.ok(
      operationLogs.some(
        (item) =>
          item.stage === "publish" &&
          item.action === "batch-finished",
      ),
    );
    assert.equal(
      operationLogs.at(-1).action,
      "finished",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("单次发布成功上限会在失败后继续尝试后续商品", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-publish-limit-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);
  const timestamp = "2026-08-02T00:00:00.000Z";
  try {
    for (let id = 1; id <= 5; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(id, undefined, discovered.imageUrl),
        timestamp,
      );
    }
    database.setXianyuSettings("account-a", 1, timestamp);
  } finally {
    database.close();
  }

  const client = new PartialPublishFailureClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({
      trigger: "schedule",
      materialConcurrency: 1,
      publishBatchSize: 2,
      publishLimit: 2,
    });
    assert.equal(sync.selectedCount, 5);
    assert.equal(sync.publishSuccess, 2);
    assert.equal(sync.publishFailed, 1);
    assert.equal(client.upsertCalls.flat().length, 5);
    assert.equal(
      client.publishCalls.reduce(
        (total, payload) => total + payload.materialIds.length,
        0,
      ),
      3,
    );
    assert.equal(
      client.publishCalls
        .flatMap((payload) => payload.materialIds)
        .includes(4),
      false,
    );
    const persisted = new CrawlerDatabase(databasePath);
    try {
      const storedRun = persisted.queryOne(
        `SELECT selected_count, publish_success, publish_failed, publish_submitted
         FROM xianyu_sync_runs
         ORDER BY id DESC
         LIMIT 1`,
      );
      assert.equal(storedRun.selected_count, 5);
      assert.equal(storedRun.publish_success, 2);
      assert.equal(storedRun.publish_failed, 1);
      assert.equal(storedRun.publish_submitted, 3);
      assert.ok(
        persisted
          .listTaskOperationLogs({
            taskType: "sync",
            runId: sync.runId,
            limit: 100,
          })
          .some((item) => item.action === "success-limit-reached"),
      );
    } finally {
      persisted.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("暂停后并发队列立即停止领取新商品", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-pause-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);
  const timestamp = "2026-07-30T00:00:00.000Z";
  try {
    for (let id = 1; id <= 3; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(id, undefined, discovered.imageUrl),
        timestamp,
      );
    }
    database.setXianyuSettings("account-a", 1, timestamp);
  } finally {
    database.close();
  }

  const client = new TrackingXianyuClient();
  const control = new TaskControl();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const running = service.run({
      trigger: "test",
      control,
      materialConcurrency: 1,
    });
    while (client.activeUpserts === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    control.pause();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(control.interrupted, true);
    assert.equal(client.upsertCalls.length, 1);
    assert.equal(client.publishCalls.length, 0);

    control.resume();
    const sync = await running;
    assert.equal(sync.publishSuccess, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("终止会结束同步任务且不会继续发布", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-terminate-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);
  const timestamp = "2026-07-30T00:00:00.000Z";
  try {
    for (let id = 1; id <= 3; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(id, undefined, discovered.imageUrl),
        timestamp,
      );
    }
    database.setXianyuSettings("account-a", 1, timestamp);
  } finally {
    database.close();
  }

  const client = new TrackingXianyuClient();
  const control = new TaskControl();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const running = service.run({
      trigger: "test",
      control,
      materialConcurrency: 1,
    });
    while (client.activeUpserts === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    control.terminate();

    const sync = await running;
    assert.equal(sync.status, "interrupted");
    assert.equal(client.publishCalls.length, 0);

    const saved = new CrawlerDatabase(databasePath);
    try {
      const run = saved.queryOne(
        "SELECT status, finished_at FROM xianyu_sync_runs ORDER BY id DESC LIMIT 1",
      );
      assert.equal(run.status, "interrupted");
      assert.ok(run.finished_at);
    } finally {
      saved.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("批量发布失败后跳过本批并继续处理后续批次", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-canary-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (let id = 1; id <= 25; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(discovered, result(id), timestamp);
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new ProbeFailureClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.selectedCount, 25);
    assert.equal(sync.status, "partial");
    assert.equal(sync.publishSubmitted, 25);
    assert.equal(sync.publishFailed, 25);
    assert.equal(client.upsertCalls.length, 25);
    assert.ok(client.publishCalls.length >= 2);
    assert.equal(
      client.publishCalls.reduce(
        (total, call) => total + call.materialIds.length,
        0,
      ),
      25,
    );
    assert.ok(
      client.publishCalls.every(
        (call) => call.materialIds.length <= 20,
      ),
    );

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const storedRun = checkedDatabase.queryOne(
      `SELECT
         status,
         material_processed_count,
         publish_selected_count,
         publish_processed_count,
         error_summary
       FROM xianyu_sync_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
    checkedDatabase.close();
    assert.equal(storedRun.status, "partial");
    assert.equal(storedRun.material_processed_count, 25);
    assert.equal(storedRun.publish_selected_count, 25);
    assert.equal(storedRun.publish_processed_count, 25);
    assert.match(storedRun.error_summary, /25 个商品发布失败/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("批量发布参数错误时跳过当前批次并继续下一批", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-rejected-batch-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (let id = 1; id <= 25; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(discovered, result(id), timestamp);
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new RejectedBatchClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test" });
    const rejectedBatchSize =
      client.publishCalls[0].materialIds.length;
    assert.equal(sync.status, "partial");
    assert.equal(sync.publishFailed, rejectedBatchSize);
    assert.equal(sync.publishSuccess, 25 - rejectedBatchSize);
    assert.equal(sync.publishProcessedCount, 25);
    assert.equal(
      client.publishCalls.reduce(
        (total, call) => total + call.materialIds.length,
        0,
      ),
      25,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("批量发布缺少商品编号时标记为待确认并停止后续批次", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-reconcile-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const discovered = game(91);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(
      discovered,
      result(discovered.id),
      timestamp,
    );
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new MissingItemIdBatchClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.status, "unknown");
    assert.equal(sync.publishSuccess, 0);
    assert.equal(sync.publishFailed, 0);
    assert.equal(client.cardBindCalls.length, 0);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const publication = checkedDatabase.queryOne(
      `SELECT status, item_id, card_bind_status
       FROM xianyu_publications
       WHERE game_id = ? AND account_id = ?`,
      discovered.id,
      "account-a",
    );
    checkedDatabase.close();
    assert.equal(publication.status, "unknown");
    assert.equal(publication.item_id, null);
    assert.equal(publication.card_bind_status, "pending");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("单个素材失败不会阻止其他商品进入发布线程", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-material-failure-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (let id = 1; id <= 5; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(id),
        timestamp,
      );
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new MaterialFailureClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.status, "partial");
    assert.equal(sync.materialFailed, 1);
    assert.equal(sync.publishSuccess, 4);
    assert.equal(sync.batchCount, client.publishCalls.length);
    assert.equal(
      client.publishCalls.reduce(
        (total, call) => total + call.materialIds.length,
        0,
      ),
      4,
    );

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const storedRun = checkedDatabase.queryOne(
      `SELECT processed_count, material_failed, publish_success
       FROM xianyu_sync_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
    const material = checkedDatabase.queryOne(
      `SELECT status, last_error FROM xianyu_account_material_sync
       WHERE game_id = 3 AND account_id = 'account-a'`,
    );
    checkedDatabase.close();
    assert.equal(storedRun.processed_count, 5);
    assert.equal(storedRun.material_failed, 1);
    assert.equal(storedRun.publish_success, 4);
    assert.equal(material.status, "failed");
    assert.match(material.last_error, /测试素材同步失败/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("封面缓存携带来源 Referer，404 时标记游戏缺失", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-cover-not-found-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (let id = 81; id <= 82; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(discovered.id),
        timestamp,
      );
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const cacheCalls = [];
  const service = new XianyuSyncService(
    config(databasePath, { coverCacheEnabled: true }),
    new FakeXianyuClient(),
    {
      cacheCover: async ({ gameId, referer }) => {
        cacheCalls.push({ gameId, referer });
        if (gameId === 81) {
          const error = new Error("封面下载返回 HTTP 404");
          error.code = "COVER_NOT_FOUND";
          throw error;
        }
        return {
          cached: false,
          publicUrl: `https://gamer520.example/covers/${gameId}.jpg`,
        };
      },
    },
  );
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.materialFailed, 1);
    assert.equal(sync.publishSuccess, 1);
    assert.deepEqual(cacheCalls, [
      {
        gameId: 81,
        referer: "https://www.gamer520.com/81.html",
      },
      {
        gameId: 82,
        referer: "https://www.gamer520.com/82.html",
      },
    ]);
    const checkedDatabase = new CrawlerDatabase(databasePath);
    const gameStatus = checkedDatabase.queryOne(
      "SELECT scrape_status, last_error FROM games WHERE id = 81",
    );
    checkedDatabase.close();
    assert.equal(gameStatus.scrape_status, "missing");
    assert.equal(gameStatus.last_error, "图片链接无法访问");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("自定义模板用于素材、封面和卡券标题，修改后不重复发布", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-template-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const discovered = game(88);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(
      discovered,
      result(discovered.id, "自定义简介"),
      timestamp,
    );
    database.setXianyuSettings(
      "account-a",
      3.5,
      timestamp,
      {
        titleTemplate: "现货 {title} #{id}",
        descriptionTemplate:
          "{description}\n网盘 {cloud_drives}\n售价 {price}",
        imageTemplate: "https://cdn.example/games/{id}.jpg",
      },
      88,
      null,
      { cardId: 6 },
    );
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const first = await service.run({ trigger: "test" });
    assert.equal(first.publishSuccess, 1);
    assert.equal(client.upsertCalls[0][0].title, "现货 游戏 88 #88");
    assert.equal(
      client.upsertCalls[0][0].description,
      "自定义简介\n网盘 百度\n售价 3.5",
    );
    assert.deepEqual(client.upsertCalls[0][0].images, [
      "https://cdn.example/games/88.jpg",
    ]);
    assert.equal(client.upsertCalls[0][0].quantity, 1);
    assert.equal(
      client.cardBindCalls[0].itemTitle,
      "现货 游戏 88 #88",
    );

    const changedDatabase = new CrawlerDatabase(databasePath);
    changedDatabase.setXianyuSettings(
      "account-a",
      3.5,
      "2026-07-29T00:00:00.000Z",
      {
        titleTemplate: "秒发 {title}",
        descriptionTemplate: "{description}\n{cloud_drives}",
        imageTemplate: "{image_url}",
      },
    );
    changedDatabase.close();

    const updated = await service.run({
      trigger: "test",
      mode: "updated",
    });
    assert.equal(updated.selectedCount, 1);
    assert.equal(updated.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.upsertCalls.length, 2);
    assert.equal(client.upsertCalls[1][0].title, "秒发 游戏 88");
    const verifiedDatabase = new CrawlerDatabase(databasePath);
    try {
      assert.equal(
        verifiedDatabase.queryOne(
          "SELECT status FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
          88,
          "account-a",
        ).status,
        "success",
      );
      assert.equal(
        verifiedDatabase.listSyncCandidates(
          "account-a",
          20,
          "updated",
        ).length,
        0,
      );
    } finally {
      verifiedDatabase.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同名商品会按外部来源 ID 分别创建和发布", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-name-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (const id of [31, 32]) {
      const discovered = game(
        id,
        `https://images.example/${id}.jpg`,
        "同名游戏",
      );
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(
          id,
          "同名游戏简介",
          discovered.imageUrl,
          "同名游戏",
        ),
        timestamp,
      );
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  const progressEvents = [];
  try {
    const sync = await service.run({
      trigger: "test",
      onProgress: (progress) => progressEvents.push(progress),
    });
    assert.equal(sync.selectedCount, 2);
    assert.equal(sync.materialSkipped, 0);
    assert.equal(sync.publishSubmitted, 2);
    assert.equal(client.publishCalls.length, 2);
    assert.equal(
      client.publishCalls.reduce(
        (total, call) => total + call.materialIds.length,
        0,
      ),
      2,
    );
    assert.equal(progressEvents.at(-1).materialSkipped, 0);
    const publishingProgress = progressEvents.find(
      (progress) =>
        progress.phase === "publishing",
    );
    assert.equal(publishingProgress.publishTotal, 2);
    assert.ok(publishingProgress.publishCompleted <= 2);
    assert.equal(publishingProgress.publishSkipped, 0);
    assert.equal(progressEvents.at(-1).publishTotal, 2);
    assert.equal(progressEvents.at(-1).publishCompleted, 2);
    assert.equal(progressEvents.at(-1).publishSkipped, 0);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const rows = checkedDatabase.queryAll(
      `SELECT status FROM xianyu_account_material_sync
       WHERE account_id = 'account-a' ORDER BY game_id`,
    );
    checkedDatabase.close();
    assert.deepEqual(
      rows.map((row) => row.status),
      ["synced", "synced"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已有素材跳过上传但进入发布线程且不虚增发布进度", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-scope-progress-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  let existingMaterialHash;
  try {
    for (let id = 71; id <= 72; id += 1) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(discovered.id),
        timestamp,
      );
    }
    database.setXianyuAccountId("account-a", timestamp);
    existingMaterialHash = database
      .listSyncCandidates("account-a", 20, "pending")
      .find((candidate) => candidate.id === 71)
      .sync_content_hash;
    database.markMaterialSynced(
      71,
      "account-a",
      7100,
      existingMaterialHash,
      timestamp,
    );
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  client.materials.set("account-a:71", {
    materialId: 7100,
    contentHash: existingMaterialHash,
    title: "游戏 71",
  });
  const cachedGameIds = [];
  const service = new XianyuSyncService(
    config(databasePath, { coverCacheEnabled: true }),
    client,
    {
      cacheCover: async ({ gameId }) => {
        cachedGameIds.push(gameId);
        return {
          cached: true,
          publicUrl: `https://gamer520.example/covers/${gameId}.jpg`,
        };
      },
    },
  );
  const progressEvents = [];
  try {
    const sync = await service.run({
      trigger: "test",
      mode: "pending",
      onProgress: (progress) => progressEvents.push(progress),
    });
    assert.equal(sync.selectedCount, 2);
    assert.equal(client.upsertCalls.length, 1);
    assert.deepEqual(
      client.publishCalls.flatMap((call) => call.materialIds).sort(
        (left, right) => left - right,
      ),
      [2, 7100],
    );
    assert.deepEqual(cachedGameIds, [72]);
    const initialProgress = progressEvents.find(
      (progress) =>
        progress.phase === "preparing" &&
        progress.total === 2,
    );
    assert.equal(initialProgress.completed, 0);
    assert.equal(initialProgress.materialCompleted, 1);
    assert.equal(initialProgress.publishCompleted, 0);
    assert.equal(progressEvents.at(-1).completed, 2);
    assert.equal(progressEvents.at(-1).materialCompleted, 2);
    assert.equal(progressEvents.at(-1).publishCompleted, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同步使用商品配置中选择的卡券，未选择时不自动绑定", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-configured-card-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-08-21T00:00:00.000Z";
  const firstGame = game(901);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([firstGame], timestamp);
    database.saveGameSuccess(firstGame, result(firstGame.id), timestamp);
    database.setXianyuSettings(
      "account-a",
      1,
      timestamp,
      null,
      null,
      null,
      { cardId: 42 },
    );
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const firstSync = await service.run({ trigger: "test" });
    assert.equal(firstSync.cardBound, 1);
    assert.deepEqual(client.cardBindCalls[0].cardIds, [42]);

    const secondGame = game(902);
    const updatedDatabase = new CrawlerDatabase(databasePath);
    try {
      updatedDatabase.upsertDiscoveredGames([secondGame], timestamp);
      updatedDatabase.saveGameSuccess(secondGame, result(secondGame.id), timestamp);
      updatedDatabase.setXianyuSettings(
        "account-a",
        1,
        "2026-08-21T00:01:00.000Z",
        null,
        null,
        null,
        { cardId: null },
      );
    } finally {
      updatedDatabase.close();
    }

    const secondSync = await service.run({ trigger: "test" });
    assert.equal(secondSync.publishSuccess, 1);
    assert.equal(secondSync.cardBound, 0);
    assert.equal(client.cardBindCalls.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已有商品编号时跳过素材同步和卡券重试", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-card-retry-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const discovered = game(66);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(
      discovered,
      result(discovered.id),
      timestamp,
    );
    database.setXianyuAccountId("account-a", timestamp);
    database.setXianyuSettings(
      "account-a",
      1,
      timestamp,
      null,
      null,
      null,
      { cardId: 6 },
    );
  } finally {
    database.close();
  }

  const client = new FlakyCardClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const first = await service.run({ trigger: "test" });
    assert.equal(first.status, "partial");
    assert.equal(first.publishSuccess, 1);
    assert.equal(first.cardBindFailed, 1);
    assert.equal(client.publishCalls.length, 1);

    const retried = await service.run({
      trigger: "test",
      mode: "pending",
    });
    assert.equal(retried.status, "success");
    assert.equal(retried.selectedCount, 0);
    assert.equal(retried.publishSubmitted, 0);
    assert.equal(retried.cardBound, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.cardBindCalls.length, 1);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const publication = checkedDatabase.queryOne(
      `SELECT status, item_id, card_id, card_bind_status
       FROM xianyu_publications
       WHERE game_id = ? AND account_id = ?`,
      discovered.id,
      "account-a",
    );
    checkedDatabase.close();
    assert.equal(publication.status, "success");
    assert.equal(publication.card_id, 6);
    assert.equal(publication.card_bind_status, "failed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已有商品编号后更新内容不重复发布，切换账号会重新发布", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-update-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const discovered = game(118842);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(
      discovered,
      result(discovered.id, "初始简介"),
      timestamp,
    );
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const first = await service.run({ trigger: "test", limit: 20 });
    assert.equal(first.publishSuccess, 1);
    assert.equal(client.publishCalls.length, 1);
    const publishedDatabase = new CrawlerDatabase(databasePath);
    assert.equal(
      publishedDatabase.queryOne(
        "SELECT xianyu_item_id FROM games WHERE id = ?",
        discovered.id,
      ).xianyu_item_id,
      "item-account-a-1",
    );
    publishedDatabase.close();

    const updatedDatabase = new CrawlerDatabase(databasePath);
    updatedDatabase.saveGameSuccess(
      discovered,
      result(discovered.id, "更新后的简介"),
      "2026-07-29T00:00:00.000Z",
    );
    updatedDatabase.close();

    const updated = await service.run({ trigger: "test", limit: 20 });
    assert.equal(updated.selectedCount, 0);
    assert.equal(updated.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.upsertCalls.length, 1);

    const pricedDatabase = new CrawlerDatabase(databasePath);
    pricedDatabase.setGameSalePrice(
      discovered.id,
      8.8,
      "2026-07-29T01:00:00.000Z",
    );
    pricedDatabase.close();

    const priced = await service.run({ trigger: "test", limit: 20 });
    assert.equal(priced.selectedCount, 0);
    assert.equal(priced.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.upsertCalls.length, 1);

    const switchedDatabase = new CrawlerDatabase(databasePath);
    switchedDatabase.setXianyuAccountId(
      "account-b",
      "2026-07-30T00:00:00.000Z",
    );
    switchedDatabase.close();

    const switched = await service.run({ trigger: "test", limit: 20 });
    assert.equal(switched.selectedCount, 1);
    assert.equal(switched.publishSuccess, 1);
    assert.equal(client.publishCalls.length, 2);
    const switchedPublicationDatabase = new CrawlerDatabase(databasePath);
    assert.equal(
      switchedPublicationDatabase.queryOne(
        `SELECT status, item_id
         FROM xianyu_publications
         WHERE game_id = ? AND account_id = ?`,
        discovered.id,
        "account-b",
      ).status,
      "success",
    );
    switchedPublicationDatabase.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("未发布和已更新同步范围只处理对应商品", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-mode-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const firstAt = "2026-07-28T00:00:00.000Z";
  const firstGame = game(501);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([firstGame], firstAt);
    database.saveGameSuccess(
      firstGame,
      result(firstGame.id, "初始简介"),
      firstAt,
    );
    database.setXianyuAccountId("account-a", firstAt);
    database.setXianyuSettings(
      "account-a",
      1,
      firstAt,
      null,
      null,
      null,
      { cardId: 6 },
    );
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    await service.run({ trigger: "test", mode: "all" });
    const repeatedAll = await service.run({
      trigger: "test",
      mode: "all",
    });
    assert.equal(repeatedAll.selectedCount, 0);
    assert.equal(repeatedAll.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);

    const changedAt = "2026-07-29T00:00:00.000Z";
    const secondGame = game(502);
    const changedDatabase = new CrawlerDatabase(databasePath);
    changedDatabase.saveGameSuccess(
      firstGame,
      result(firstGame.id, "更新后的简介"),
      changedAt,
    );
    changedDatabase.upsertDiscoveredGames([secondGame], changedAt);
    changedDatabase.saveGameSuccess(
      secondGame,
      result(secondGame.id, "新商品简介"),
      changedAt,
    );
    changedDatabase.close();

    const pending = await service.run({
      trigger: "test",
      mode: "pending",
    });
    assert.equal(pending.mode, "pending");
    assert.equal(pending.selectedCount, 1);
    assert.equal(pending.publishSuccess, 1);
    assert.equal(
      client.upsertCalls.at(-1)[0].external_id,
      `account-a:${secondGame.id}`,
    );

    const updated = await service.run({
      trigger: "test",
      mode: "updated",
    });
    assert.equal(updated.mode, "updated");
    assert.equal(updated.selectedCount, 1);
    assert.equal(updated.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("每次发布前均以闲鱼素材库和商品管理状态回写本地", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-preflight-state-sync-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const selectedGame = game(503);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([selectedGame], timestamp);
    database.saveGameSuccess(
      selectedGame,
      result(selectedGame.id),
      timestamp,
    );
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const first = await service.run({ trigger: "test" });
    assert.equal(first.publishSuccess, 1);
    assert.equal(client.listMaterialCalls, 1);

    client.materials.clear();
    client.accountItems.set("account-a", []);
    const second = await service.run({ trigger: "test" });
    assert.equal(second.selectedCount, 1);
    assert.equal(second.publishSuccess, 1);
    assert.equal(client.listMaterialCalls, 2);
    assert.equal(client.upsertCalls.length, 2);
    assert.equal(client.publishCalls.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("自选游戏强制发布以闲鱼实际商品列表为准", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-force-publish-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const selectedGame = game(503);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([selectedGame], timestamp);
    database.saveGameSuccess(
      selectedGame,
      result(selectedGame.id),
      timestamp,
    );
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    await service.run({ trigger: "test", mode: "all" });
    const refreshCountBeforeForceCheck = client.refreshAccountItemCalls.length;

    const stillPublished = await service.run({
      trigger: "test",
      mode: "selected-force",
      gameIds: [selectedGame.id],
    });
    assert.equal(stillPublished.selectedCount, 0);
    assert.equal(stillPublished.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(
      client.refreshAccountItemCalls.length,
      refreshCountBeforeForceCheck + 1,
    );

    client.accountItems.set("account-a", []);
    const republishedAfterManualDeletion = await service.run({
      trigger: "test",
      mode: "selected-force",
      gameIds: [selectedGame.id],
    });
    assert.equal(republishedAfterManualDeletion.selectedCount, 1);
    assert.equal(republishedAfterManualDeletion.publishSuccess, 1);
    assert.equal(client.publishCalls.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("同步范围按发布结果和内容变更筛选待处理商品", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-scope-filter-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const firstAt = "2026-07-28T00:00:00.000Z";
  const changedAt = "2026-07-29T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    const games = [801, 802, 803, 804].map((id) => game(id));
    for (const discovered of games) {
      database.upsertDiscoveredGames([discovered], firstAt);
      database.saveGameSuccess(
        discovered,
        result(discovered.id, "初始简介"),
        firstAt,
      );
    }
    database.setXianyuAccountId("account-a", firstAt);

    const initialCandidates = database.listSyncCandidates(
      "account-a",
      20,
      "all",
    );
    for (const id of [802, 803, 804]) {
      const candidate = initialCandidates.find((item) => item.id === id);
      database.markMaterialSynced(
        id,
        "account-a",
        id * 10,
        candidate.sync_content_hash,
        firstAt,
      );
      database.markPublicationSubmitted(
        id,
        "account-a",
        id * 10,
        `batch-${id}`,
        firstAt,
      );
    }
    database.markPublicationResult({
      gameId: 802,
      accountId: "account-a",
      status: "failed",
      errorMessage: "发布失败",
      updatedAt: firstAt,
    });
    for (const id of [803, 804]) {
      database.markPublicationResult({
        gameId: id,
        accountId: "account-a",
        status: "success",
        itemId: `item-${id}`,
        updatedAt: firstAt,
      });
      database.markCardBindingResult({
        gameId: id,
        accountId: "account-a",
        cardId: 6,
        status: "success",
        updatedAt: firstAt,
      });
    }
    const updatedGame = game(804);
    database.saveGameSuccess(
      updatedGame,
      result(updatedGame.id, "更新后的简介"),
      changedAt,
    );

    assert.deepEqual(
      database
        .listSyncCandidates("account-a", 20, "pending")
        .map((candidate) => candidate.id),
      [801],
    );
    assert.deepEqual(
      database
        .listSyncCandidates("account-a", 20, "all")
        .map((candidate) => candidate.id),
      [802, 801],
    );
    assert.deepEqual(
      database
        .listSyncCandidates("account-a", 20, "updated")
        .map((candidate) => candidate.id)
        .sort((left, right) => left - right),
      [801, 802, 804],
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("单游戏同步只处理指定游戏 ID", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-single-game-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (const id of [701, 702]) {
      const discovered = game(id);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(discovered, result(id), timestamp);
    }
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({
      trigger: "test-single",
      gameIds: [702],
    });
    assert.equal(sync.selectedCount, 1);
    assert.equal(sync.publishSuccess, 1);
    assert.equal(client.upsertCalls.length, 1);
    assert.equal(client.upsertCalls[0][0].external_id, "account-a:702");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("缺少 games.image_url 时即使使用固定模板也不会进入同步队列", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-image-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const discovered = game(118843);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(
      discovered,
      result(discovered.id, "简介", null),
      timestamp,
    );
    database.database
      .prepare("UPDATE games SET image_url = NULL WHERE id = ?")
      .run(discovered.id);
    database.setXianyuAccountId("account-a", timestamp);
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test", limit: 20 });
    assert.equal(sync.selectedCount, 0);
    assert.equal(client.upsertCalls.length, 0);
    assert.equal(client.publishCalls.length, 0);
    const checkedDatabase = new CrawlerDatabase(databasePath);
    const material = checkedDatabase.queryOne(
      "SELECT status, last_error FROM xianyu_material_sync WHERE game_id = ?",
      discovered.id,
    );
    checkedDatabase.close();
    assert.equal(material.status, "pending");
    assert.equal(material.last_error, null);

    const configuredDatabase = new CrawlerDatabase(databasePath);
    configuredDatabase.setXianyuSettings(
      "account-a",
      1,
      "2026-07-29T00:00:00.000Z",
      {
        titleTemplate: "【秒发】{title}",
        descriptionTemplate: "{description}",
        imageTemplate: "https://cdn.example/static-cover.jpg",
      },
    );
    configuredDatabase.close();

    const configuredSync = await service.run({
      trigger: "test",
      mode: "all",
    });
    assert.equal(configuredSync.selectedCount, 0);
    assert.equal(configuredSync.publishSuccess, 0);
    assert.equal(client.upsertCalls.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("指定多个账号运行同步时使用统一自动分流批量接口", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-multi-account-config-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-08-17T00:00:00.000Z";
  const discovered = game(901);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(discovered, result(discovered.id), timestamp);
    database.setXianyuSettings(
      "account-a",
      2.5,
      timestamp,
      {
        titleTemplate: "A-{title}",
        descriptionTemplate: "A-{description}",
        imageTemplate: "{image_url}",
      },
      10,
      "shop-batch",
    );
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    await service.run({ trigger: "test", accountId: "account-a" });
    await service.run({ trigger: "test", accountId: "account-b" });

    assert.equal(client.upsertCalls.length, 2);
    assert.deepEqual(
      client.upsertCalls.map(([payload]) => ({
        title: payload.title,
        price: payload.price,
        externalId: payload.external_id,
        quantity: payload.quantity,
      })),
      [
        {
          title: "A-游戏 901",
          price: 2.5,
          externalId: "account-a:901",
          quantity: 1,
        },
        {
          title: "A-游戏 901",
          price: 2.5,
          externalId: "account-b:901",
          quantity: 1,
        },
      ],
    );
    assert.deepEqual(
      client.publishCalls.map((call) => call.accountId),
      [
        "account-a",
        "account-b",
      ],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("鱼小铺账号将库存、规格和 SKU 写入独立素材", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-fish-shop-material-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-08-18T00:00:00.000Z";
  const discovered = game(990);
  const database = new CrawlerDatabase(databasePath);
  try {
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(discovered, result(discovered.id), timestamp);
    database.setXianyuSettings(
      "account-a",
      3.5,
      timestamp,
      null,
      20,
      "batch",
      {
        originalPrice: 9.9,
        category: "虚拟商品",
        condition: "全新",
        shippingMethod: "none",
        postage: 0,
        address: "上海市",
        addressExpectedText: "上海",
        supportPickup: false,
        brand: "Gamer520",
        platformAttributes: [
          {
            property_id: "p1",
            property_name: "版本",
            value_id: "v1",
            value_name: "标准版",
          },
        ],
        fish: {
          quantity: 20,
          specifications: [
            {
              name: "版本",
              values: [{ name: "标准版" }],
              support_image: false,
            },
          ],
          skuRows: [
            {
              specs: { 版本: "标准版" },
              price: 3.5,
              stock: 20,
            },
          ],
        },
      },
    );
  } finally {
    database.close();
  }

  const client = new FakeXianyuClient();
  client.capabilities.set("account-a", {
    account_id: "account-a",
    account_type: "fish-shop",
    supports: {
      quantity: true,
      specifications: true,
      sku_rows: true,
      shipping_methods: ["free", "none"],
    },
  });
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.publishSuccess, 1);
    assert.deepEqual(client.upsertCalls[0][0], {
      external_id: "account-a:990",
      content_hash: client.upsertCalls[0][0].content_hash,
      title: "【秒发】游戏 990",
      description: client.upsertCalls[0][0].description,
      price: 3.5,
      original_price: 9.9,
      images: ["https://images.example/990.jpg"],
      category: "虚拟商品",
      platform_category_id: "500000",
      platform_category_name: "虚拟商品",
      platform_channel_category_id: "500001",
      platform_channel_category_name: "虚拟服务",
      platform_leaf_id: "500002",
      platform_tb_category_id: "500003",
      platform_category_path: [{ id: "500001", name: "虚拟服务" }],
      category_source: "recommendation",
      platform_attributes: [
        {
          property_id: "p1",
          property_name: "版本",
          value_id: "v1",
          value_name: "标准版",
        },
      ],
      quantity: 20,
      delivery_method: "express",
      shipping_method: "none",
      support_pickup: false,
      postage: 0,
      address: "上海市",
      address_expected_text: "上海",
      brand: "Gamer520",
      condition: "全新",
      specifications: [
        {
          name: "版本",
          values: [{ name: "标准版" }],
          support_image: false,
        },
      ],
      sku_rows: [
        {
          specs: { 版本: "标准版" },
          price: 3.5,
          stock: 20,
        },
      ],
      remark: "来源 gamer520，账号 account-a，商品ID 990",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
