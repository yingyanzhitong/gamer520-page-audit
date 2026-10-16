import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CrawlerDatabase } from "../src/database.mjs";
import { startDashboardServer } from "../src/dashboard-server.mjs";

const timestamp = "2026-10-16T00:00:00.000Z";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "item-history-"));
  const dbPath = path.join(directory, "test.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = new CrawlerDatabase(dbPath);
  database.upsertDiscoveredGames([97812, 49084].map((id) => ({
    id,
    title: `当前游戏标题 ${id}`,
    sourceUrl: `https://www.gamer520.com/${id}.html`,
    imageUrl: null,
    hotPage: 1,
    hotPosition: 1,
    hotRank: 1,
  })), timestamp);
  return { dbPath, database };
}

function publish(database, accountId, itemId, gameId = 97812) {
  database.markPublicationSubmitted(gameId, accountId, gameId, "batch", timestamp);
  database.markPublicationResult({
    gameId, accountId, itemId, status: "success", updatedAt: timestamp,
  });
}

async function reader(t, dbPath) {
  const dashboard = await startDashboardServer({
    dbPath,
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
    downloadReadApiKey: "read-key",
  });
  t.after(() => dashboard.close());
  return async (itemId) => {
    const response = await fetch(
      `http://127.0.0.1:${dashboard.address.port}/api/download-sources`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-Key": "read-key" },
        body: JSON.stringify({ item_id: itemId, item_title: "历史标题已不再匹配" }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
}

test("同游戏三个账号的商品编号及重发前的旧编号均能找到游戏", async (t) => {
  const { dbPath, database } = fixture(t);
  try {
    publish(database, "account-a", "old-item");
    database.reconcileAccountPublishedItems(
      "account-a", [{ item_id: "unrelated-item" }], timestamp,
    );
    assert.equal(database.queryOne(
      "SELECT item_id FROM xianyu_publications WHERE account_id = 'account-a'",
    ).item_id, null);
    publish(database, "account-a", "new-item");
    publish(database, "account-b", "other-account-item");
    database.reconcileAccountPublishedItems(
      "account-b", [{ item_id: "unrelated-item" }], timestamp,
    );
    database.markPublicationSubmitted(97812, "account-b", 97812, "retry", timestamp);
    database.markPublicationResult({
      gameId: 97812, accountId: "account-b", status: "failed", updatedAt: timestamp,
    });
    publish(database, "account-c", "third-account-item");
  } finally {
    database.close();
  }
  const lookup = await reader(t, dbPath);
  for (const itemId of ["old-item", "new-item", "other-account-item", "third-account-item"]) {
    const result = await lookup(itemId);
    assert.equal(result.status, 200, itemId);
    assert.equal(result.body.game.id, 97812);
    assert.equal(result.body.lookup.strategy, "item_id");
  }
});

test("已有发布记录时，空商品列表会中止核对并保留所有账号的关联", (t) => {
  const { database } = fixture(t);
  try {
    // 新账号没有历史记录时，空列表允许正常进入首次发布。
    assert.equal(database.reconcileAccountPublishedItems(
      "new-account", [], timestamp,
    ).materialFallbackCount, 0);
    publish(database, "account-a", "item-a");
    publish(database, "account-b", "item-b");
    const before = database.queryOne("SELECT * FROM games WHERE id = 97812");
    assert.throws(() => database.reconcileAccountPublishedItems(
      "account-a", [], timestamp,
    ), (error) => error.statusCode === 409 && /商品列表为空/.test(error.message));
    assert.deepEqual(database.queryOne("SELECT * FROM games WHERE id = 97812"), before);
    assert.deepEqual(database.queryAll(
      "SELECT account_id, status, item_id FROM xianyu_publications ORDER BY account_id",
    ).map((row) => ({ ...row })), [
      { account_id: "account-a", status: "success", item_id: "item-a" },
      { account_id: "account-b", status: "success", item_id: "item-b" },
    ]);
  } finally {
    database.close();
  }
});

test("升级时从成功任务日志恢复被清空的编号，且不改变当前发布状态", async (t) => {
  const { dbPath, database } = fixture(t);
  const runId = database.startSyncRun("test", "鹰眼", "all", 2, timestamp);
  for (const [gameId, itemId] of [[97812, "1077535870662"], [49084, "1079604912861"]]) {
    database.recordTaskLog({
      taskType: "sync", runId, gameId, stage: "publish", action: "success",
      message: "发布成功", details: { itemId }, createdAt: timestamp,
    });
    database.markPublicationSubmitted(gameId, "鹰眼", gameId, "retry", timestamp);
    database.markPublicationResult({
      gameId, accountId: "鹰眼", status: "failed", updatedAt: timestamp,
    });
  }
  database.recordTaskLog({
    taskType: "sync", runId, gameId: 97812, stage: "publish", action: "failed",
    message: "发布失败", details: { itemId: "unconfirmed-item" }, createdAt: timestamp,
  });
  database.recordTaskLog({
    taskType: "sync", runId, gameId: 97812, stage: "publish", action: "success",
    message: "缺少有效日志详情", createdAt: timestamp,
  });
  database.database.prepare(`
    UPDATE task_operation_logs SET detail_json = 'invalid json'
    WHERE message = '缺少有效日志详情'
  `).run();
  publish(database, "account-b", "existing-item");
  database.database.exec("DROP TABLE IF EXISTS xianyu_item_history; PRAGMA user_version = 22;");
  database.close();

  // Dashboard 启动会执行数据库升级，并通过真实下载源接口核验历史编号。
  const lookup = await reader(t, dbPath);
  for (const [itemId, gameId] of [
    ["1077535870662", 97812], ["1079604912861", 49084], ["existing-item", 97812],
  ]) {
    const result = await lookup(itemId);
    assert.equal(result.status, 200, itemId);
    assert.equal(result.body.game.id, gameId);
  }
  assert.equal((await lookup("unconfirmed-item")).status, 404);
  const migrated = new CrawlerDatabase(dbPath);
  try {
    assert.deepEqual(migrated.queryAll(
      "SELECT status, item_id FROM xianyu_publications WHERE account_id = '鹰眼' ORDER BY game_id",
    ).map((row) => ({ ...row })), [
      { status: "failed", item_id: null }, { status: "failed", item_id: null },
    ]);
    assert.equal(migrated.queryOne(
      "SELECT count(*) AS count FROM xianyu_item_history",
    ).count, 3);
  } finally {
    migrated.close();
  }
});

test("查询发布状态补录的商品编号会保留历史映射", async (t) => {
  const { dbPath, database } = fixture(t);
  database.reconcileAccountPublishedItems(
    "account-a", [{ item_id: "reconciled-item", title: "当前游戏标题 97812" }],
    timestamp, { titleForGame: (game) => game.title },
  );
  database.reconcileAccountPublishedItems(
    "account-a", [{ item_id: "unrelated-item" }], timestamp,
  );
  database.close();
  const lookup = await reader(t, dbPath);
  const result = await lookup("reconciled-item");
  assert.equal(result.status, 200);
  assert.equal(result.body.game.id, 97812);
});

test("升级时只读历史部署备份，恢复已不在当前记录及任务日志中的编号", async (t) => {
  const { dbPath, database } = fixture(t);
  publish(database, "account-a", "backup-only-item");
  database.database.prepare(`
    UPDATE games SET xianyu_item_id = 'legacy-summary-item', xianyu_account_id = NULL
    WHERE id = 49084
  `).run();
  const backupPath = path.join(path.dirname(dbPath), "gamer520-before-2.0.52.sqlite");
  database.database.prepare("VACUUM INTO ?").run(backupPath);
  const backupContents = fs.readFileSync(backupPath);
  database.reconcileAccountPublishedItems(
    "account-a", [{ item_id: "unrelated-item" }], timestamp,
  );
  database.database.prepare(`
    UPDATE games SET xianyu_item_id = NULL, xianyu_account_id = NULL WHERE id = 49084
  `).run();
  publish(database, "account-a", "current-item");
  database.database.exec("DROP TABLE xianyu_item_history; PRAGMA user_version = 22;");
  database.close();

  const lookup = await reader(t, dbPath);
  for (const [itemId, gameId] of [
    ["backup-only-item", 97812], ["legacy-summary-item", 49084], ["current-item", 97812],
  ]) {
    const result = await lookup(itemId);
    assert.equal(result.status, 200, itemId);
    assert.equal(result.body.game.id, gameId);
  }
  assert.deepEqual(fs.readFileSync(backupPath), backupContents);
});

test("历史编号若指向多个游戏则返回冲突，拒绝发送任意游戏", async (t) => {
  const { dbPath, database } = fixture(t);
  publish(database, "account-a", "conflicting-item", 97812);
  database.reconcileAccountPublishedItems(
    "account-a", [{ item_id: "unrelated-item" }], timestamp,
  );
  publish(database, "account-b", "conflicting-item", 49084);
  database.close();
  const lookup = await reader(t, dbPath);
  const result = await lookup("conflicting-item");
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.candidates.map((game) => game.id), [49084, 97812]);
});

test("从闲鱼成功发布日志按素材来源恢复三个账号的编号，并过滤无效来源", async (t) => {
  const { dbPath, database } = fixture(t);
  const materials = [
    { id: 1, source_type: "gamer520", source_item_id: "account-a:97812" },
    { id: 2, source_type: "gamer520", source_item_id: "account-b:97812" },
    { id: 3, source_type: "gamer520", source_item_id: "account-c:97812" },
    { id: 4, source_type: "other-source", source_item_id: "account-a:97812" },
    { id: 5, source_type: "gamer520", source_item_id: "account-a:999999" },
    { id: 6, source_type: "gamer520", source_item_id: "49084" },
  ];
  const logs = [
    { material_id: 1, account_id: "account-a", item_id: "remote-a", status: "success" },
    { material_id: 2, account_id: "account-b", item_id: "remote-b", status: "success" },
    { material_id: 3, account_id: "account-c", item_id: "remote-c", status: "success" },
    { material_id: 4, account_id: "account-a", item_id: "other-source", status: "success" },
    { material_id: 5, account_id: "account-a", item_id: "missing-game", status: "success" },
    { material_id: 1, account_id: "account-b", item_id: "wrong-account", status: "success" },
    { material_id: 1, account_id: "account-a", item_id: "failed-item", status: "failed" },
    { material_id: 6, account_id: "account-a", item_id: "legacy-source", status: "success" },
  ];
  try {
    assert.deepEqual(database.restorePublishedItemHistory(materials, logs, timestamp), {
      matchedCount: 4, restoredCount: 4,
    });
    assert.equal(database.restorePublishedItemHistory(materials, logs, timestamp).restoredCount, 0);
    assert.equal(database.queryOne("SELECT count(*) AS count FROM xianyu_publications").count, 0);
  } finally {
    database.close();
  }
  const lookup = await reader(t, dbPath);
  for (const itemId of ["remote-a", "remote-b", "remote-c"]) {
    const result = await lookup(itemId);
    assert.equal(result.status, 200);
    assert.equal(result.body.game.id, 97812);
  }
  assert.equal((await lookup("legacy-source")).body.game.id, 49084);
  for (const itemId of ["other-source", "missing-game", "wrong-account", "failed-item"]) {
    assert.equal((await lookup(itemId)).status, 404, itemId);
  }
});
