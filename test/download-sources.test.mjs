import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CrawlerDatabase } from "../src/database.mjs";
import { startDashboardServer } from "../src/dashboard-server.mjs";

test("下载源按商品编号、完整标题、唯一截短标题依次匹配", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "download-sources-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(dbPath);
  const timestamp = "2026-10-16T00:00:00.000Z";
  const titles = [
    [97812, "使命召唤®:现代战争® III 2023|豪华中文|Build.19183238-灭世危机-丧尸围城|解压即撸|"],
    [49084, "木筏求生 Raft|官方中文|V1.1.01Fix+全DLC+修改器|解压即撸|"],
    [1, "重名游戏|官方中文|标准版"],
    [2, "重名游戏|官方中文|豪华版"],
    [3, "特殊_%游戏|官方中文|完整版"],
    [4, "特殊AB游戏|官方中文|完整版"],
  ];
  database.upsertDiscoveredGames(titles.map(([id, title]) => ({
    id,
    title,
    sourceUrl: `https://www.gamer520.com/${id}.html`,
    imageUrl: "https://images.example/game.jpg",
    hotPage: 1,
    hotPosition: 1,
    hotRank: 1,
  })), timestamp);
  database.markPublicationSubmitted(49084, "account-a", 1, "test-batch", timestamp);
  database.markPublicationResult({
    gameId: 49084,
    accountId: "account-a",
    status: "success",
    itemId: "known-item",
    updatedAt: timestamp,
  });
  database.close();

  const dashboard = await startDashboardServer({
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
    dbPath,
    downloadReadApiKey: "test-read-key",
  });
  t.after(() => dashboard.close());
  const lookup = async (body) => {
    const response = await fetch(
      `http://127.0.0.1:${dashboard.address.port}/api/download-sources`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "test-read-key",
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };

  for (const itemTitle of [titles[0][1], "不存在的标题", "【秒发】"]) {
    await t.test(`商品编号命中后忽略其他条件：${itemTitle}`, async () => {
      const result = await lookup({
        item_id: "known-item",
        item_title: itemTitle,
        id: "无效游戏编号",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.game.id, 49084);
      assert.equal(result.body.lookup.strategy, "item_id");
    });
  }

  await t.test("商品编号未命中时使用完整标题，不校验未用到的游戏编号", async () => {
    const result = await lookup({
      item_id: "unknown-item",
      item_title: `【秒发】${titles[0][1]}`,
      id: "无效游戏编号",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.game.id, 97812);
    assert.equal(result.body.lookup.strategy, "item_title");
  });

  for (const [itemId, itemTitle, gameId] of [
    ["1077535870662", "【秒发】使命召唤®:现代战争® III 2023|豪华中文|", 97812],
    ["1079604912861", "【秒发】木筏求生 Raft|官方中文|V1.1.01Fix+", 49084],
    ["unknown-item", "【秒发】特殊_%游戏|官方中文|", 3],
  ]) {
    await t.test(`商品编号未命中后按唯一截短标题匹配：${gameId}`, async () => {
      const result = await lookup({ item_id: itemId, item_title: itemTitle });
      assert.equal(result.status, 200);
      assert.equal(result.body.game.id, gameId);
      assert.equal(result.body.lookup.strategy, "item_title");
    });
  }

  await t.test("截短标题匹配多个游戏时拒绝返回任意卡券", async () => {
    const result = await lookup({ item_title: "【秒发】重名游戏|官方中文|" });
    assert.equal(result.status, 409);
    assert.deepEqual(result.body.candidates.map((game) => game.id), [1, 2]);
    assert.equal(result.body.data, undefined);
  });

  await t.test("完整标题优先于共享前缀的其他版本", async () => {
    const result = await lookup({ item_title: titles[2][1] });
    assert.equal(result.status, 200);
    assert.equal(result.body.game.id, 1);
  });

  await t.test("不把残缺游戏名当作可匹配的截短标题", async () => {
    assert.equal((await lookup({ item_title: "【秒发】使命召唤" })).status, 404);
    assert.equal((await lookup({ item_title: "【秒发】" })).status, 422);
    assert.equal((await lookup({ id: "无效游戏编号" })).status, 422);
  });
});
