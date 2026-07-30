import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeGameContentHash,
  CrawlerDatabase,
} from "../src/database.mjs";

function discovery(id, title, rank) {
  return {
    id,
    sourceUrl: `https://www.gamer520.com/${id}.html`,
    title,
    imageUrl: `https://images.example/${id}.jpg`,
    hotPage: Math.ceil(rank / 20),
    hotPosition: ((rank - 1) % 20) + 1,
    hotRank: rank,
  };
}

function result(id, title, downloadUrl) {
  return {
    page: {
      url: `https://www.gamer520.com/${id}.html`,
      title,
      image: `https://images.example/${id}-detail.jpg`,
      gameDescription: `${title}简介`,
      sourceUpdatedAt: "2026-07-20T00:00:00.000Z",
    },
    resource: {
      resourceCode: `A${id}`,
      detailPageUrl: `https://gamers520.com/${id}.html`,
      archivePassword: "laoquzhang.com",
      downloads: [
        {
          provider: "百度网盘",
          url: downloadUrl,
          password: "abcd",
          extractionCode: "abcd",
          qrImageUrl: "https://qr.example/code.png",
          qrDecodeMethod: "test",
        },
      ],
    },
  };
}

test("相同游戏 ID 覆盖详情并替换下载源", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-db-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);

  try {
    const firstSeen = "2026-07-28T00:00:00.000Z";
    const secondSeen = "2026-07-29T00:00:00.000Z";
    const game = discovery(118834, "旧标题", 10);

    database.upsertDiscoveredGames(
      [game, discovery(106813, "保留记录", 11)],
      firstSeen,
    );
    database.saveGameSuccess(
      game,
      result(118834, "旧详情", "https://pan.example/old"),
      firstSeen,
    );

    const updated = discovery(118834, "新列表标题", 2);
    database.upsertDiscoveredGames([updated], secondSeen);
    database.saveGameSuccess(
      updated,
      result(118834, "新详情", "https://pan.example/new"),
      secondSeen,
    );

    const games = database.queryAll(
      "SELECT * FROM games ORDER BY id",
    );
    const downloads = database.queryAll(
      "SELECT * FROM downloads WHERE game_id = ?",
      118834,
    );

    assert.equal(games.length, 2);
    assert.equal(
      games.find((row) => row.id === 118834).title,
      "新详情",
    );
    assert.equal(
      games.find((row) => row.id === 118834).hot_rank,
      2,
    );
    assert.equal(
      games.find((row) => row.id === 106813).last_seen_at,
      firstSeen,
    );
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].url, "https://pan.example/new");
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("详情失败保留旧成功字段和下载源", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-db-failure-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);

  try {
    const timestamp = "2026-07-28T00:00:00.000Z";
    const game = discovery(118842, "列表标题", 1);
    database.upsertDiscoveredGames([game], timestamp);
    database.saveGameSuccess(
      game,
      result(118842, "成功详情", "https://pan.example/ok"),
      timestamp,
    );
    database.upsertDiscoveredGames(
      [
        {
          ...game,
          title: "失败轮次的列表标题",
          imageUrl: "https://images.example/failed-list-image.jpg",
        },
      ],
      "2026-07-29T00:00:00.000Z",
    );
    database.saveGameFailure(
      game.id,
      "TimeoutError: 页面超时",
      "2026-07-29T00:00:00.000Z",
    );

    const stored = database.queryOne(
      "SELECT * FROM games WHERE id = ?",
      game.id,
    );
    const downloads = database.queryAll(
      "SELECT * FROM downloads WHERE game_id = ?",
      game.id,
    );

    assert.equal(stored.title, "成功详情");
    assert.equal(
      stored.image_url,
      "https://images.example/118842-detail.jpg",
    );
    assert.equal(stored.scrape_status, "failed");
    assert.match(stored.last_error, /页面超时/);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].url, "https://pan.example/ok");
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("启动新任务前标记未正常结束的旧任务", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-db-interrupted-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);

  try {
    const startedAt = "2026-07-28T00:00:00.000Z";
    const interruptedAt = "2026-07-28T01:00:00.000Z";
    const runId = database.startRun("startup", startedAt, {});
    const syncRunId = database.startSyncRun(
      "startup",
      "account-a",
      "all",
      1,
      startedAt,
    );
    database.updateSyncRun(syncRunId, {
      selected_count: 690,
      processed_count: 20,
    });

    database.markInterruptedRuns(interruptedAt);

    const run = database.queryOne(
      "SELECT * FROM crawl_runs WHERE id = ?",
      runId,
    );
    assert.equal(run.status, "interrupted");
    assert.equal(run.finished_at, interruptedAt);
    assert.match(run.error_summary, /进程在任务完成前退出/);
    database.close();

    const reopened = new CrawlerDatabase(databasePath);
    const syncRun = reopened.queryOne(
      "SELECT status, selected_count, processed_count FROM xianyu_sync_runs WHERE id = ?",
      syncRunId,
    );
    reopened.close();
    assert.equal(syncRun.status, "interrupted");
    assert.equal(syncRun.selected_count, 690);
    assert.equal(syncRun.processed_count, 20);
  } finally {
    try {
      database.close();
    } catch {
      // 上方已关闭数据库以验证重新打开后的迁移行为。
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("内容哈希忽略热度并对下载源排序", () => {
  const game = {
    title: "测试游戏",
    description: "简介",
    imageUrl: "https://images.example/cover.jpg",
    resourceCode: "A100",
    detailPageUrl: "https://gamers520.com/100.html",
    archivePassword: "password",
    hotRank: 1,
  };
  const downloads = [
    {
      provider: "夸克网盘",
      url: "https://pan.example/b",
      extractionCode: "b",
    },
    {
      provider: "百度网盘",
      url: "https://pan.example/a",
      extractionCode: "a",
    },
  ];

  assert.equal(
    computeGameContentHash(game, downloads),
    computeGameContentHash(
      { ...game, hotRank: 999 },
      [...downloads].reverse(),
    ),
  );
  assert.notEqual(
    computeGameContentHash(game, downloads),
    computeGameContentHash(
      { ...game, description: "简介已更新" },
      downloads,
    ),
  );
});

test("首次成功标记新增，内容变化后标记更新", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-db-change-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "test.sqlite"),
  );

  try {
    const firstAt = "2026-07-28T00:00:00.000Z";
    const secondAt = "2026-07-29T00:00:00.000Z";
    const thirdAt = "2026-07-30T00:00:00.000Z";
    const game = discovery(100001, "列表标题", 1);
    database.upsertDiscoveredGames([game], firstAt);
    database.saveGameSuccess(
      game,
      result(100001, "详情标题", "https://pan.example/original"),
      firstAt,
    );
    assert.equal(
      database.queryOne("SELECT last_change_type FROM games WHERE id = ?", game.id)
        .last_change_type,
      "new",
    );

    const rankChanged = { ...game, hotRank: 80, hotPage: 4 };
    database.upsertDiscoveredGames([rankChanged], secondAt);
    database.saveGameSuccess(
      rankChanged,
      result(100001, "详情标题", "https://pan.example/original"),
      secondAt,
    );
    const unchanged = database.queryOne(
      "SELECT last_change_type, last_changed_at FROM games WHERE id = ?",
      game.id,
    );
    assert.equal(unchanged.last_change_type, "new");
    assert.equal(unchanged.last_changed_at, firstAt);

    database.saveGameSuccess(
      rankChanged,
      result(100001, "详情标题", "https://pan.example/updated"),
      thirdAt,
    );
    const updated = database.queryOne(
      "SELECT last_change_type, last_changed_at FROM games WHERE id = ?",
      game.id,
    );
    assert.equal(updated.last_change_type, "updated");
    assert.equal(updated.last_changed_at, thirdAt);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("来源更新时间未变化时只更新检查时间并保留详情", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-db-source-time-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "test.sqlite"),
  );

  try {
    const firstAt = "2026-07-28T00:00:00.000Z";
    const checkedAt = "2026-07-29T00:00:00.000Z";
    const sourceUpdatedAt = "2026-07-20T00:00:00.000Z";
    const discovered = discovery(100003, "来源时间测试", 1);
    const detail = result(
      discovered.id,
      "来源时间测试",
      "https://pan.example/original",
    );
    detail.page.sourceUpdatedAt = sourceUpdatedAt;

    database.upsertDiscoveredGames([discovered], firstAt);
    database.saveGameSuccess(discovered, detail, firstAt);
    const refreshState = database.getGameRefreshState(discovered.id);
    assert.equal(refreshState.source_updated_at, sourceUpdatedAt);

    database.upsertDiscoveredGames([discovered], checkedAt);
    database.markGameAttempt(discovered.id, checkedAt);
    database.saveGameUnchanged(
      discovered.id,
      sourceUpdatedAt,
      checkedAt,
    );

    const stored = database.queryOne(
      "SELECT * FROM games WHERE id = ?",
      discovered.id,
    );
    assert.equal(stored.last_scraped_at, firstAt);
    assert.equal(stored.last_attempt_at, checkedAt);
    assert.equal(stored.source_updated_at, sourceUpdatedAt);
    assert.equal(stored.scrape_status, "success");
    assert.equal(
      database.queryOne(
        "SELECT COUNT(*) AS count FROM downloads WHERE game_id = ?",
        discovered.id,
      ).count,
      1,
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("下载源消失时记录告警且不改动已发布商品", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-db-download-warning-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "test.sqlite"),
  );

  try {
    const firstAt = "2026-07-28T00:00:00.000Z";
    const secondAt = "2026-07-29T00:00:00.000Z";
    const discovered = discovery(100002, "测试游戏", 1);
    database.upsertDiscoveredGames([discovered], firstAt);
    database.saveGameSuccess(
      discovered,
      result(100002, "测试游戏", "https://pan.example/original"),
      firstAt,
    );
    const stored = database.queryOne(
      "SELECT content_hash FROM games WHERE id = ?",
      discovered.id,
    );
    database.markMaterialSynced(
      discovered.id,
      200,
      stored.content_hash,
      firstAt,
    );
    database.markPublicationSubmitted(
      discovered.id,
      "account-a",
      200,
      "batch-a",
      firstAt,
    );
    database.markPublicationResult({
      gameId: discovered.id,
      accountId: "account-a",
      status: "success",
      itemId: "item-a",
      itemUrl: "https://www.goofish.com/item?id=item-a",
      updatedAt: firstAt,
    });

    const withoutDownloads = result(
      100002,
      "测试游戏",
      "https://pan.example/original",
    );
    withoutDownloads.resource.downloads = [];
    database.saveGameSuccess(
      discovered,
      withoutDownloads,
      secondAt,
    );

    assert.equal(
      database.queryOne(
        "SELECT COUNT(*) AS count FROM downloads WHERE game_id = ?",
        discovered.id,
      ).count,
      0,
    );
    const material = database.queryOne(
      "SELECT status, last_error FROM xianyu_material_sync WHERE game_id = ?",
      discovered.id,
    );
    assert.equal(material.status, "failed");
    assert.match(material.last_error, /下载资源已消失/);
    assert.equal(
      database.queryOne(
        "SELECT status FROM xianyu_publications WHERE game_id = ? AND account_id = ?",
        discovered.id,
        "account-a",
      ).status,
      "success",
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("任务调度设置写入单例配置并覆盖更新", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-schedule-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "schedule.sqlite"),
  );
  try {
    const initial = database.getSchedulerSettings(
      {
        cronTimezone: "Asia/Shanghai",
        crawlCronSchedule: "0 3 * * *",
        crawlEnabled: true,
        syncCronSchedule: "0 */6 * * *",
        syncEnabled: true,
        syncMode: "all",
        crawlConcurrency: 3,
        materialConcurrency: 4,
        publishConcurrency: 4,
      },
      "2026-07-28T00:00:00.000Z",
    );
    assert.equal(initial.crawl_cron_schedule, "0 3 * * *");
    assert.equal(initial.sync_enabled, 1);
    assert.equal(initial.sync_mode, "all");
    assert.equal(initial.crawl_concurrency, 3);
    assert.equal(initial.material_concurrency, 4);
    assert.equal(initial.publish_concurrency, 4);

    const updated = database.setSchedulerSettings(
      {
        cronTimezone: "Asia/Shanghai",
        crawlCronSchedule: "30 4 * * *",
        crawlEnabled: false,
        syncCronSchedule: "15 */8 * * *",
        syncEnabled: true,
        syncMode: "updated",
        crawlConcurrency: 5,
        materialConcurrency: 6,
        publishConcurrency: 2,
      },
      "2026-07-28T01:00:00.000Z",
    );
    assert.equal(updated.crawl_cron_schedule, "30 4 * * *");
    assert.equal(updated.crawl_enabled, 0);
    assert.equal(updated.sync_cron_schedule, "15 */8 * * *");
    assert.equal(updated.sync_mode, "updated");
    assert.equal(updated.crawl_concurrency, 5);
    assert.equal(updated.material_concurrency, 6);
    assert.equal(updated.publish_concurrency, 2);
    assert.equal(
      database.queryOne("PRAGMA user_version").user_version,
      11,
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("任务操作日志和服务 Key 持久化并支持增删", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-task-log-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "test.sqlite"),
  );
  try {
    const timestamp = "2026-07-30T00:00:00.000Z";
    const runId = database.startRun("test", timestamp, {});
    database.recordTaskLog({
      taskType: "crawl",
      runId,
      gameId: 118842,
      level: "success",
      stage: "detail",
      action: "saved",
      message: "详情保存成功",
      details: { downloadCount: 2 },
      createdAt: timestamp,
    });
    const logs = database.listTaskOperationLogs({
      taskType: "crawl",
      runId,
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].game_id, 118842);
    assert.deepEqual(JSON.parse(logs[0].detail_json), {
      downloadCount: 2,
    });

    database.setXianyuApiKey("xyk-test-value", timestamp);
    assert.equal(database.getXianyuApiKey(), "xyk-test-value");
    database.addDownloadApiKey({
      id: "key-1",
      name: "测试调用方",
      apiKey: "g5k-test-value",
      createdAt: timestamp,
    });
    assert.equal(database.listDownloadApiKeys().length, 1);
    assert.equal(database.deleteDownloadApiKey("key-1"), true);
    assert.equal(database.listDownloadApiKeys().length, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("发布成功后把闲鱼商品编号写回游戏数据", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-item-id-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "test.sqlite"),
  );
  try {
    const timestamp = "2026-07-28T00:00:00.000Z";
    const discovered = discovery(118900, "发布编号测试", 1);
    database.upsertDiscoveredGames([discovered], timestamp);
    database.saveGameSuccess(
      discovered,
      result(118900, "发布编号测试", "https://pan.example/item"),
      timestamp,
    );
    const stored = database.queryOne(
      "SELECT content_hash FROM games WHERE id = ?",
      discovered.id,
    );
    database.markMaterialSynced(
      discovered.id,
      900,
      stored.content_hash,
      timestamp,
    );
    database.markPublicationSubmitted(
      discovered.id,
      "account-a",
      900,
      "batch-a",
      timestamp,
    );
    database.markPublicationResult({
      gameId: discovered.id,
      accountId: "account-a",
      status: "success",
      itemId: "1069000000000",
      itemUrl: "https://www.goofish.com/item?id=1069000000000",
      updatedAt: timestamp,
    });

    const gameRow = database.queryOne(
      `SELECT
         xianyu_item_id,
         xianyu_item_url,
         xianyu_account_id,
         xianyu_published_at
       FROM games
       WHERE id = ?`,
      discovered.id,
    );
    assert.equal(gameRow.xianyu_item_id, "1069000000000");
    assert.equal(
      gameRow.xianyu_item_url,
      "https://www.goofish.com/item?id=1069000000000",
    );
    assert.equal(gameRow.xianyu_account_id, "account-a");
    assert.equal(gameRow.xianyu_published_at, timestamp);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("闲鱼同步候选只保留有效 HTTP 下载资源", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-sync-download-filter-test-"),
  );
  const database = new CrawlerDatabase(
    path.join(directory, "test.sqlite"),
  );
  try {
    const timestamp = "2026-07-30T00:00:00.000Z";
    const cases = [
      [120001, "有效资源", "https://pan.example/valid"],
      [120002, "空下载地址", ""],
      [120003, "非网页协议", "ftp://pan.example/file"],
      [120004, "无有效图片", "https://pan.example/no-image"],
    ];
    for (const [id, title, url] of cases) {
      const discovered = discovery(id, title, id - 120000);
      database.upsertDiscoveredGames([discovered], timestamp);
      database.saveGameSuccess(
        discovered,
        result(id, title, url),
        timestamp,
      );
    }
    database.database
      .prepare("UPDATE games SET image_url = NULL WHERE id = ?")
      .run(120004);
    database.setXianyuAccountId("account-a", timestamp);

    const candidates = database.listSyncCandidates(
      "account-a",
      20,
      "all",
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.id),
      [120001],
    );
    assert.deepEqual(
      candidates[0].downloads.map((download) => download.url),
      ["https://pan.example/valid"],
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
