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
  }

  async listAccounts() {
    return [
      { accountId: "account-a", enabled: true, remark: "A" },
      { accountId: "account-b", enabled: true, remark: "B" },
    ];
  }

  async upsertMaterials(items) {
    this.upsertCalls.push(items);
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
    return { batch_id: payload.requestId };
  }

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
        item_id: `item-${call.accountId}-${materialId}`,
        item_url: `https://www.goofish.com/item?id=${materialId}`,
      })),
    };
  }
}

function config(databasePath) {
  return {
    dbPath: databasePath,
    syncRunLimit: 20,
    syncPollIntervalMs: 1,
    syncBatchTimeoutMs: 100,
    xianyuApiKey: "unused-by-fake",
    xianyuBaseUrl: "https://xianyu.example",
  };
}

test("全量同步按每批 20 条并使用封面、售价和动态网盘介绍", async () => {
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

  const client = new FakeXianyuClient();
  const service = new XianyuSyncService(config(databasePath), client);
  try {
    const sync = await service.run({ trigger: "test", limit: 20 });
    assert.equal(sync.selectedCount, 21);
    assert.equal(sync.batchCount, 2);
    assert.equal(client.upsertCalls[0].length, 20);
    assert.equal(client.upsertCalls[1].length, 1);
    assert.equal(client.publishCalls[0].materialIds.length, 20);
    assert.equal(client.publishCalls[1].materialIds.length, 1);
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
      client.upsertCalls[0][0].description,
      /支持网盘：百度\/夸克\/迅雷/,
    );
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
  try {
    const sync = await service.run({ trigger: "test" });
    assert.equal(sync.selectedCount, 2);
    assert.equal(sync.materialSkipped, 1);
    assert.equal(sync.publishSubmitted, 1);
    assert.equal(client.publishCalls[0].materialIds.length, 1);

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
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
