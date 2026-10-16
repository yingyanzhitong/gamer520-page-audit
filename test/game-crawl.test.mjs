import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startDashboardServer } from "../src/dashboard-server.mjs";
import { CrawlerDatabase } from "../src/database.mjs";

test("单独采集受鉴权保护，支持缺失和失败游戏，并只提交指定游戏", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gamer520-game-crawl-"));
  const dbPath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(dbPath);
  const timestamp = "2026-10-16T00:00:00.000Z";
  database.upsertDiscoveredGames(
    [1, 2, 3].map((id) => ({
      id,
      sourceUrl: `https://www.gamer520.com/${id}.html`,
      title: `游戏 ${id}`,
      tags: ["PC PLAY"],
      imageUrl: null,
      hotPage: 1,
      hotPosition: id,
      hotRank: id,
    })),
    timestamp,
  );
  database.database.exec("UPDATE games SET scrape_status = 'missing' WHERE id = 1");
  database.saveGameFailure(2, "测试失败", timestamp);
  database.setGameViolationStatus(3, "violation", timestamp);
  database.close();

  const calls = [];
  let queued = false;
  const handlers = {
    triggerCrawl: (reason, options) => {
      calls.push({ reason, options });
      return queued
        ? { queued: true, queueId: "queue-crawl", queuePosition: 1 }
        : { active: true, queued: false };
    },
  };
  const dashboard = await startDashboardServer(
    { dashboardHost: "127.0.0.1", dashboardPort: 0, dbPath, xianyuApiKey: "test-key" },
    () => ({}),
    handlers,
  );
  const baseUrl = `http://127.0.0.1:${dashboard.address.port}`;
  const submit = (id, key = "test-key") => fetch(`${baseUrl}/api/games/${id}/crawl`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": key },
    body: "{}",
  });

  try {
    assert.equal((await submit(1, "wrong-key")).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await submit(999)).status, 404);
    assert.equal(calls.length, 0);

    for (const id of [1, 2, 3]) {
      const response = await submit(id);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.gameId, id);
      assert.equal(payload.active, true);
      assert.match(payload.message, /采集任务已启动/);
      assert.deepEqual(calls.at(-1), {
        reason: "manual-game",
        options: { gameIds: [id] },
      });
    }

    queued = true;
    const queuedResponse = await submit(2);
    assert.equal(queuedResponse.status, 200);
    const queuedPayload = await queuedResponse.json();
    assert.equal(queuedPayload.queued, true);
    assert.match(queuedPayload.message, /已加入任务队列/);
    assert.deepEqual(calls.at(-1).options, { gameIds: [2] });

    delete handlers.triggerCrawl;
    assert.equal((await submit(1)).status, 503);
    assert.equal(calls.length, 4);
  } finally {
    await dashboard.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
