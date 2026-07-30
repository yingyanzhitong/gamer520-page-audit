import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CrawlerDatabase } from "../src/database.mjs";
import { XianyuSyncService } from "../src/sync-service.mjs";

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
      const duplicate = [...this.materials.values()].find(
        (material) => material.title === item.title,
      );
      if (!previous && duplicate) {
        return {
          external_id: item.external_id,
          material_id: duplicate.materialId,
          action: "skipped",
          reason: "素材库已存在同名商品",
        };
      }
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

  async refreshAccountItems() {
    return { success: true };
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
    if (items[0]?.external_id === "3") {
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

class MisreportedFailureClient extends FakeXianyuClient {
  async getBatchStatus(batchId) {
    const success = await super.getBatchStatus(batchId);
    return {
      ...success,
      items: success.items.map((item) => ({
        ...item,
        status: "failed",
        item_id: null,
        item_url: null,
        error_message: "可能发布失败（页面未跳转，仍停留在发布页）",
      })),
    };
  }
}

function config(databasePath) {
  return {
    dbPath: databasePath,
    syncPollIntervalMs: 1,
    syncBatchTimeoutMs: 100,
    xianyuApiKey: "unused-by-fake",
    xianyuBaseUrl: "https://xianyu.example",
    publicBaseUrl: "https://gamer520.example",
    coverCacheDir: path.join(path.dirname(databasePath), "covers"),
    coverCacheEnabled: false,
  };
}

test("素材最多 4 个并行并按 20 件批量发布", async () => {
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
    database.setXianyuSettings("account-a", 2.5, timestamp);
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
      onProgress: (progress) => progressEvents.push(progress),
    });
    assert.equal(sync.selectedCount, 21);
    assert.equal(sync.batchCount, 2);
    assert.equal(client.upsertCalls.length, 21);
    assert.equal(client.publishCalls.length, 2);
    assert.equal(client.cardBindCalls.length, 21);
    assert.equal(client.maxActiveUpserts, 4);
    assert.ok(client.upsertCalls.every((items) => items.length === 1));
    assert.deepEqual(
      client.publishCalls.map(
        (payload) => payload.materialIds.length,
      ),
      [1, 20],
    );
    assert.ok(
      client.events
        .slice(0, 21)
        .every((event) => event.type === "material"),
    );
    assert.equal(client.events[21].type, "publish");
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
        `https://images.example/${item.external_id}.jpg`,
      ]);
      assert.equal(
        item.price,
        item.external_id === "1" ? 9.9 : 2.5,
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
    assert.equal(storedRun.batch_count, 2);
    assert.equal(storedRun.requested_limit, 20);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("探针商品失败后停止后续批次", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-canary-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const timestamp = "2026-07-28T00:00:00.000Z";
  const database = new CrawlerDatabase(databasePath);
  try {
    for (let id = 1; id <= 5; id += 1) {
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
    assert.equal(sync.status, "partial");
    assert.equal(sync.publishSubmitted, 1);
    assert.equal(sync.publishFailed, 1);
    assert.equal(client.upsertCalls.length, 5);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.publishCalls[0].materialIds.length, 1);
    assert.match(sync.safetyStopReason, /探针商品发布失败/);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const storedRun = checkedDatabase.queryOne(
      `SELECT
         status,
         publish_selected_count,
         publish_processed_count,
         error_summary
       FROM xianyu_sync_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
    checkedDatabase.close();
    assert.equal(storedRun.status, "partial");
    assert.equal(storedRun.publish_selected_count, 5);
    assert.equal(storedRun.publish_processed_count, 1);
    assert.match(storedRun.error_summary, /探针商品发布失败/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("商品列表新增记录会纠正页面未跳转的失败结果", async () => {
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

  const client = new MisreportedFailureClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.status, "success");
    assert.equal(sync.publishSuccess, 1);
    assert.equal(sync.publishFailed, 0);
    assert.equal(client.cardBindCalls.length, 1);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const publication = checkedDatabase.queryOne(
      `SELECT status, item_id, card_bind_status
       FROM xianyu_publications
       WHERE game_id = ? AND account_id = ?`,
      discovered.id,
      "account-a",
    );
    checkedDatabase.close();
    assert.equal(publication.status, "success");
    assert.equal(publication.item_id, "item-account-a-1");
    assert.equal(publication.card_bind_status, "success");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("单个素材失败不会阻止其他商品进入尾批发布", async () => {
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
    assert.equal(sync.batchCount, 2);
    assert.equal(client.publishCalls.length, 2);
    assert.deepEqual(
      client.publishCalls.map((call) => call.materialIds.length),
      [1, 3],
    );

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const storedRun = checkedDatabase.queryOne(
      `SELECT processed_count, material_failed, publish_success
       FROM xianyu_sync_runs
       ORDER BY id DESC
       LIMIT 1`,
    );
    const material = checkedDatabase.queryOne(
      "SELECT status, last_error FROM xianyu_material_sync WHERE game_id = 3",
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
    assert.equal(client.upsertCalls.at(-1)[0].title, "秒发 游戏 88");
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

test("同名商品只创建和发布一次，其余记录标记跳过", async () => {
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
    assert.equal(sync.materialSkipped, 1);
    assert.equal(sync.publishSubmitted, 1);
    assert.equal(client.publishCalls[0].materialIds.length, 1);
    assert.equal(progressEvents.at(-1).materialSkipped, 1);

    const checkedDatabase = new CrawlerDatabase(databasePath);
    const rows = checkedDatabase.queryAll(
      "SELECT status FROM xianyu_material_sync ORDER BY game_id",
    );
    checkedDatabase.close();
    assert.deepEqual(
      rows.map((row) => row.status),
      ["synced", "skipped"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("卡券关联失败只重试卡券，不重复发布商品", async () => {
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
    assert.equal(retried.publishSubmitted, 0);
    assert.equal(retried.cardBound, 1);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.cardBindCalls.length, 2);

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
    assert.equal(publication.card_bind_status, "success");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("已发布商品更新只更新素材，切换账号后才重新发布", async () => {
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
    assert.equal(updated.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.match(
      client.upsertCalls.at(-1)[0].description,
      /^更新后的简介\n\n支持网盘：百度/,
    );

    const pricedDatabase = new CrawlerDatabase(databasePath);
    pricedDatabase.setGameSalePrice(
      discovered.id,
      8.8,
      "2026-07-29T01:00:00.000Z",
    );
    pricedDatabase.close();

    const priced = await service.run({ trigger: "test", limit: 20 });
    assert.equal(priced.publishSubmitted, 0);
    assert.equal(client.publishCalls.length, 1);
    assert.equal(client.upsertCalls.at(-1)[0].price, 8.8);

    const switchedDatabase = new CrawlerDatabase(databasePath);
    switchedDatabase.setXianyuAccountId(
      "account-b",
      "2026-07-30T00:00:00.000Z",
    );
    switchedDatabase.close();

    const switched = await service.run({ trigger: "test", limit: 20 });
    assert.equal(switched.publishSuccess, 1);
    assert.equal(client.publishCalls.length, 2);
    assert.equal(client.publishCalls.at(-1).accountId, "account-b");
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
    assert.equal(repeatedAll.selectedCount, 1);
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
      String(secondGame.id),
    );

    const updated = await service.run({
      trigger: "test",
      mode: "updated",
    });
    assert.equal(updated.mode, "updated");
    assert.equal(updated.selectedCount, 1);
    assert.equal(updated.publishSubmitted, 0);
    assert.equal(
      client.upsertCalls.at(-1)[0].external_id,
      String(firstGame.id),
    );
    assert.equal(client.publishCalls.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("缺少 games.image_url 的商品不会进入同步队列", async () => {
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
    assert.equal(material.status, "failed");
    assert.match(material.last_error, /image_url 缺失/);

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
    assert.equal(configuredSync.selectedCount, 1);
    assert.equal(configuredSync.publishSuccess, 1);
    assert.deepEqual(client.upsertCalls[0][0].images, [
      "https://cdn.example/static-cover.jpg",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
