import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startDashboardServer } from "../src/dashboard-server.mjs";
import { CrawlerDatabase } from "../src/database.mjs";
import { TaskQueue } from "../src/task-queue.mjs";

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

test("重采无下载源仅提交零资源游戏，保留排队范围，空范围不触发全量采集", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gamer520-missing-downloads-"));
  const dbPath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(dbPath);
  const timestamp = "2026-10-16T00:00:00.000Z";
  database.upsertDiscoveredGames(
    [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      sourceUrl: `https://www.gamer520.com/${id}.html`,
      title: `游戏 ${id}`,
      imageUrl: null,
      hotPage: 1,
      hotPosition: id,
      hotRank: id,
    })),
    timestamp,
  );
  database.database.exec(`
    UPDATE games SET scrape_status = 'success', last_scraped_at = '${timestamp}';
    UPDATE games SET scrape_status = 'missing' WHERE id IN (1, 4, 5);
    UPDATE games SET scrape_status = 'failed' WHERE id = 2;
  `);
  const addDownload = (id) => database.database.prepare(`
    INSERT INTO downloads (game_id, provider, url, created_at, updated_at)
    VALUES (?, 'GOFILE 海外盘', ?, ?, ?)
  `).run(id, `https://gofile.io/d/game-${id}`, timestamp, timestamp);
  [3, 4, 5].forEach(addDownload);

  const calls = [];
  const queue = new TaskQueue();
  let busy = false;
  const handlers = {
    triggerCrawl(reason, options) {
      calls.push({ reason, options });
      if (!busy) return { active: true, queued: false };
      const accepted = queue.enqueue({ taskType: "crawl", reason, options });
      return { queued: true, queuePosition: accepted.queuePosition };
    },
  };
  const dashboard = await startDashboardServer(
    { dashboardHost: "127.0.0.1", dashboardPort: 0, dbPath, xianyuApiKey: "test-key" },
    () => ({}),
    handlers,
  );
  const submit = (body, key = "test-key") => fetch(
    `http://127.0.0.1:${dashboard.address.port}/api/crawl/run`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
    },
  );
  try {
    assert.equal((await submit({ mode: "missing-downloads" }, "wrong-key")).status, 401);
    assert.equal((await submit({ mode: "unknown" })).status, 422);
    assert.equal(calls.length, 0);

    const started = await submit({ mode: "missing-downloads" });
    assert.equal(started.status, 200);
    const startedPayload = await started.json();
    assert.equal(startedPayload.gameCount, 3);
    assert.equal(startedPayload.mode, "missing-downloads");
    assert.match(startedPayload.message, /3 个无下载源游戏/);
    assert.deepEqual(calls.at(-1), {
      reason: "manual-missing-downloads",
      options: { gameIds: [1, 2, 6] },
    });

    busy = true;
    const queued = await (await submit({ mode: "missing-downloads" })).json();
    assert.equal(queued.queued, true);
    assert.match(queued.message, /已加入任务队列/);
    assert.deepEqual(queue.list()[0].gameIds, [1, 2, 6]);
    assert.equal(queue.list()[0].reason, "manual-missing-downloads");

    [1, 2, 6].forEach(addDownload);
    const empty = await (await submit({ mode: "missing-downloads" })).json();
    assert.equal(empty.gameCount, 0);
    assert.equal(empty.active, false);
    assert.equal(empty.queued, false);
    assert.match(empty.message, /无需重新采集/);
    assert.equal(calls.length, 2);
    assert.equal(queue.size, 1);

    const full = await submit({});
    assert.equal(full.status, 200);
    assert.deepEqual(calls.at(-1), { reason: "manual", options: undefined });
  } finally {
    await dashboard.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
