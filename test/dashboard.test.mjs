import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startDashboardServer } from "../src/dashboard-server.mjs";
import { CrawlerDatabase } from "../src/database.mjs";

function statistics() {
  return {
    listPagesSucceeded: 1,
    listPagesFailed: 0,
    discoveredCount: 3,
    detailSucceeded: 1,
    detailFailed: 0,
    detailSkipped: 2,
  };
}

function postDownloadSources(baseUrl, body, key = null) {
  const headers = {
    "content-type": "application/json",
  };
  if (key) headers["X-API-Key"] = key;
  return fetch(`${baseUrl}/api/download-sources`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("管理界面直接展示下载源并使用闲鱼 API Key 保护同步操作", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-dashboard-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);
  const timestamp = "2026-07-28T00:00:00.000Z";
  const game = {
    id: 118842,
    sourceUrl: "https://www.gamer520.com/118842.html",
    title: "黄昏远征军",
    imageUrl: "https://images.example/118842.jpg",
    hotPage: 1,
    hotPosition: 1,
    hotRank: 1,
  };
  const runId = database.startRun("test", timestamp, {});
  database.upsertDiscoveredGames([game], timestamp);
  database.saveGameSuccess(
    game,
    {
      page: {
        url: game.sourceUrl,
        title: game.title,
        image: game.imageUrl,
        gameDescription: "测试游戏简介",
      },
      resource: {
        resourceCode: "A310235",
        detailPageUrl: "https://gamers520.com/40265.html",
        archivePassword: "laoquzhang.com",
        downloads: [
          {
            provider: "百度网盘",
            url: "https://pan.example/download?pwd=e15a",
            password: "e15a",
            extractionCode: "e15a",
            qrImageUrl: null,
            qrDecodeMethod: "test",
          },
        ],
      },
    },
    timestamp,
  );
  database.finishRun(
    runId,
    "success",
    "2026-07-28T00:01:00.000Z",
    statistics(),
  );
  const storedGame = database.queryOne(
    "SELECT content_hash FROM games WHERE id = ?",
    game.id,
  );
  database.markMaterialSynced(
    game.id,
    842,
    storedGame.content_hash,
    timestamp,
  );
  database.markPublicationSubmitted(
    game.id,
    "account-a",
    842,
    "batch-842",
    timestamp,
  );
  database.markPublicationResult({
    gameId: game.id,
    accountId: "account-a",
    status: "success",
    itemId: "1067769058126",
    itemUrl: "https://www.goofish.com/item?id=1067769058126",
    updatedAt: timestamp,
  });
  database.setXianyuAccountId("account-a", timestamp);
  database.saveGameSuccess(
    game,
    {
      page: {
        url: game.sourceUrl,
        title: game.title,
        image: game.imageUrl,
        gameDescription: "更新后的测试游戏简介",
      },
      resource: {
        resourceCode: "A310235",
        detailPageUrl: "https://gamers520.com/40265.html",
        archivePassword: "laoquzhang.com",
        downloads: [
          {
            provider: "百度网盘",
            url: "https://pan.example/download?pwd=e15a",
            password: "e15a",
            extractionCode: "e15a",
            qrImageUrl: null,
            qrDecodeMethod: "test",
          },
        ],
      },
    },
    "2026-07-28T00:01:30.000Z",
  );
  const syncRunId = database.startSyncRun(
    "test",
    "account-a",
    "all",
    1,
    timestamp,
  );
  database.updateSyncRun(syncRunId, {
    status: "success",
    selected_count: 3,
    processed_count: 3,
    material_unchanged: 1,
    material_skipped: 2,
    material_processed_count: 3,
    publish_selected_count: 1,
    publish_processed_count: 1,
    publish_submitted: 1,
    publish_success: 1,
    batch_count: 1,
    finished_at: "2026-07-28T00:02:00.000Z",
  });
  database.close();

  let savedSchedule = null;
  let crawlTrigger = null;
  let syncTrigger = null;
  let taskControl = null;
  const dashboard = await startDashboardServer(
    {
      dashboardHost: "127.0.0.1",
      dashboardPort: 0,
      dbPath: databasePath,
      downloadReadApiKey: "download-secret",
      xianyuApiKey: "xianyu-secret",
      pageCount: 100,
    },
    () => ({
      active: false,
      interrupted: false,
      enabled: true,
      cronSchedule: "0 3 * * *",
      cronTimezone: "Asia/Shanghai",
      runOnStart: true,
      nextRun: "2026-07-28T19:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      sync: {
        active: false,
        interrupted: false,
        enabled: true,
        cronSchedule: "0 */6 * * *",
        cronTimezone: "Asia/Shanghai",
        nextRun: "2026-07-28T18:00:00.000Z",
        mode: "all",
        progress: {
          runId: syncRunId,
          total: 10,
          completed: 4,
          materialTotal: 10,
          materialCompleted: 4,
          materialSkipped: 2,
          publishTotal: 5,
          publishCompleted: 2,
          currentGameId: 118842,
          currentTitle: "黄昏远征军",
          phase: "publishing",
        },
      },
    }),
    {
      listXianyuAccounts: async () => [
        {
          accountId: "account-a",
          enabled: true,
          remark: "主账号",
        },
        {
          accountId: "account-disabled",
          enabled: false,
          remark: "停用",
        },
      ],
      validateXianyuAccount: async (accountId) => {
        if (accountId !== "account-a") {
          const error = new Error("账号不存在或无权访问");
          error.statusCode = 403;
          throw error;
        }
        return { accountId, enabled: true, remark: "主账号" };
      },
      updateScheduleSettings: (settings) => {
        savedSchedule = settings;
        return {
          active: false,
          enabled: settings.crawlEnabled,
          cronSchedule: settings.crawlCronSchedule,
          cronTimezone: settings.cronTimezone,
          nextRun: "2026-07-29T20:30:00.000Z",
          sync: {
            active: false,
            interrupted: false,
            enabled: settings.syncEnabled,
            cronSchedule: settings.syncCronSchedule,
            cronTimezone: settings.cronTimezone,
            nextRun: "2026-07-29T16:15:00.000Z",
            mode: settings.syncMode,
          },
        };
      },
      triggerCrawl: (trigger) => {
        crawlTrigger = trigger;
        return { trigger, mode: "full", active: true };
      },
      triggerSync: (trigger, mode, options = {}) => {
        syncTrigger = { trigger, mode, options };
        return {
          trigger,
          mode,
          gameIds: options.gameIds ?? null,
          active: true,
        };
      },
      controlTask: (task, action) => {
        taskControl = { task, action };
        return {
          active: task === "crawl",
          interrupted: action === "interrupt",
          sync: {
            active: task === "sync",
            interrupted:
              task === "sync" && action === "interrupt",
            mode: "all",
          },
        };
      },
    },
  );
  const baseUrl = `http://127.0.0.1:${dashboard.address.port}`;

  try {
    const summary = await fetch(`${baseUrl}/api/dashboard`).then(
      (response) => response.json(),
    );
    assert.equal(summary.totals.games, 1);
    assert.equal(summary.totals.downloads, 1);
    assert.equal(summary.latestRun.status, "success");
    assert.equal(summary.latestRun.detailSkipped, 2);
    assert.equal(summary.scheduler.cronTimezone, "Asia/Shanghai");

    const schedule = await fetch(
      `${baseUrl}/api/settings/schedule`,
    ).then((response) => response.json());
    assert.equal(schedule.crawl.cronSchedule, "0 3 * * *");
    assert.equal(schedule.sync.enabled, true);
    assert.equal(schedule.sync.mode, "all");
    assert.equal(schedule.sync.progress.completed, 4);
    assert.equal(schedule.sync.progress.materialSkipped, 2);
    assert.equal(schedule.sync.progress.materialCompleted, 4);
    assert.equal(schedule.sync.progress.publishCompleted, 2);

    const pageSource = await fetch(baseUrl).then((response) =>
      response.text(),
    );
    const scriptPath = pageSource.match(
      /<script[^>]+src="([^"]+)"[^>]*>/,
    )?.[1];
    assert.ok(scriptPath);
    const appSource = await fetch(`${baseUrl}${scriptPath}`).then(
      (response) => response.text(),
    );
    assert.match(pageSource, /id="root"/);
    assert.match(appSource, /运营看板/);
    assert.match(appSource, /任务记录/);
    assert.match(appSource, /商品配置/);
    assert.match(appSource, /游戏数据/);
    assert.match(appSource, /API Key 管理/);
    assert.match(appSource, /导入素材库/);
    assert.match(appSource, /发布商品/);
    assert.match(appSource, /图片链接/);

    const games = await fetch(
      `${baseUrl}/api/games?query=118842&status=success`,
    ).then((response) => response.json());
    assert.equal(games.total, 1);
    assert.equal(games.items[0].title, "黄昏远征军");
    assert.equal(games.items[0].xianyuItemId, "1067769058126");

    const updatedPublishedGames = await fetch(
      `${baseUrl}/api/games?status=updated&xianyuStatus=material_update`,
    ).then((response) => response.json());
    assert.equal(updatedPublishedGames.total, 1);
    assert.equal(updatedPublishedGames.items[0].lastChangeType, "updated");
    assert.equal(
      updatedPublishedGames.items[0].xianyuStatus,
      "material_update",
    );

    const noXianyuStateGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=none`,
    ).then((response) => response.json());
    assert.equal(noXianyuStateGames.total, 0);

    const gamesByItem = await fetch(
      `${baseUrl}/api/games?query=1067769058126`,
    ).then((response) => response.json());
    assert.equal(gamesByItem.total, 1);
    assert.equal(gamesByItem.items[0].id, 118842);

    const detail = await fetch(`${baseUrl}/api/games/118842`).then(
      (response) => response.json(),
    );
    assert.equal(detail.game.archivePassword, "laoquzhang.com");
    assert.equal(
      detail.game.imageUrl,
      "https://images.example/118842.jpg",
    );
    assert.equal(detail.downloads[0].extractionCode, "e15a");

    const legacyGet = await fetch(
      `${baseUrl}/api/download-sources?id=118842`,
      { headers: { "X-API-Key": "download-secret" } },
    );
    assert.equal(legacyGet.status, 405);

    const unauthorizedSources = await postDownloadSources(
      baseUrl,
      { id: 118842 },
    );
    assert.equal(unauthorizedSources.status, 401);

    const sources = await postDownloadSources(
      baseUrl,
      { id: 118842 },
      "download-secret",
    ).then((response) => response.json());
    assert.equal(sources.downloads[0].extractionCode, "e15a");
    assert.equal(sources.game.id, 118842);
    assert.equal(sources.resourceCode, "A310235");
    assert.equal(sources.archivePassword, "laoquzhang.com");
    assert.equal(
      sources.data,
      "解压密码：laoquzhang.com\n百度网盘：https://pan.example/download?pwd=e15a 提取码：e15a",
    );

    const sourcesByItem = await postDownloadSources(
      baseUrl,
      {
        item_id: "1067769058126",
        item_title: "不存在的名称",
        id: 999999,
      },
      "download-secret",
    ).then((response) => response.json());
    assert.equal(sourcesByItem.itemId, "1067769058126");
    assert.equal(sourcesByItem.game.id, 118842);
    assert.equal(sourcesByItem.archivePassword, "laoquzhang.com");
    assert.equal(sourcesByItem.downloads.length, 1);
    assert.equal(sourcesByItem.lookup.strategy, "item_id");

    const sourcesByPrefixedTitle = await postDownloadSources(
      baseUrl,
      {
        item_id: "不存在的商品编号",
        item_title: "【 秒发 】 黄昏远征军",
        id: 999999,
      },
      "download-secret",
    ).then((response) => response.json());
    assert.equal(sourcesByPrefixedTitle.game.id, 118842);
    assert.equal(sourcesByPrefixedTitle.archivePassword, "laoquzhang.com");
    assert.equal(
      sourcesByPrefixedTitle.lookup.normalizedItemTitle,
      "黄昏远征军",
    );
    assert.equal(
      sourcesByPrefixedTitle.lookup.strategy,
      "item_title",
    );
    assert.equal(sourcesByPrefixedTitle.downloads.length, 1);
    assert.equal(
      sourcesByPrefixedTitle.data.split("\n").length,
      2,
    );

    const sourcesByFallbackId = await postDownloadSources(
      baseUrl,
      {
        item_id: "不存在的商品编号",
        item_title: "不存在的名称",
        id: 118842,
      },
      "download-secret",
    ).then((response) => response.json());
    assert.equal(sourcesByFallbackId.game.id, 118842);
    assert.equal(sourcesByFallbackId.lookup.strategy, "id");

    const embeddedPrefix = await postDownloadSources(
      baseUrl,
      { item_title: "黄昏【秒发】远征军" },
      "download-secret",
    );
    assert.equal(embeddedPrefix.status, 200);

    const emptyPrefixedTitle = await postDownloadSources(
      baseUrl,
      { item_title: "【秒发 】" },
      "download-secret",
    );
    assert.equal(emptyPrefixedTitle.status, 422);

    const deprecatedName = await postDownloadSources(
      baseUrl,
      { name: "黄昏远征军" },
      "download-secret",
    );
    assert.equal(deprecatedName.status, 422);

    const missingQuery = await postDownloadSources(
      baseUrl,
      {},
      "download-secret",
    );
    assert.equal(missingQuery.status, 422);

    const statusDatabase = new CrawlerDatabase(databasePath);
    statusDatabase.markMaterialSynced(
      game.id,
      842,
      "current-material-hash",
      timestamp,
    );
    statusDatabase.close();
    const publishedGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=published`,
    ).then((response) => response.json());
    assert.equal(publishedGames.total, 1);
    assert.equal(publishedGames.items[0].xianyuStatus, "published");

    const publishingDatabase = new CrawlerDatabase(databasePath);
    publishingDatabase.markPublicationSubmitted(
      game.id,
      "account-a",
      842,
      "batch-status-test",
      timestamp,
    );
    publishingDatabase.close();
    const publishingGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=publishing`,
    ).then((response) => response.json());
    assert.equal(publishingGames.total, 1);
    assert.equal(publishingGames.items[0].xianyuStatus, "publishing");

    const materialDatabase = new CrawlerDatabase(databasePath);
    materialDatabase.markPublicationResult({
      gameId: game.id,
      accountId: "account-a",
      status: "failed",
      errorMessage: "测试发布失败",
      updatedAt: timestamp,
    });
    materialDatabase.close();
    const materialGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=material`,
    ).then((response) => response.json());
    assert.equal(materialGames.total, 1);
    assert.equal(materialGames.items[0].xianyuStatus, "material");

    const noneDatabase = new CrawlerDatabase(databasePath);
    noneDatabase.database
      .prepare("DELETE FROM xianyu_publications WHERE game_id = ?")
      .run(game.id);
    noneDatabase.database
      .prepare("DELETE FROM xianyu_material_sync WHERE game_id = ?")
      .run(game.id);
    noneDatabase.close();
    const noneGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=none`,
    ).then((response) => response.json());
    assert.equal(noneGames.total, 1);
    assert.equal(noneGames.items[0].xianyuStatus, "none");

    const runs = await fetch(`${baseUrl}/api/runs?limit=12`).then(
      (response) => response.json(),
    );
    assert.deepEqual(
      runs.map((run) => run.taskType).sort(),
      ["crawl", "sync"],
    );
    assert.equal(
      runs.find((run) => run.taskType === "sync").processedCount,
      3,
    );
    assert.equal(
      runs.find((run) => run.taskType === "crawl").detailSkipped,
      2,
    );
    assert.equal(
      runs.find((run) => run.taskType === "sync").materialSkipped,
      2,
    );
    assert.equal(
      runs.find((run) => run.taskType === "sync").materialProcessedCount,
      3,
    );
    assert.equal(
      runs.find((run) => run.taskType === "sync").publishProcessedCount,
      1,
    );
    const logs = await fetch(`${baseUrl}/api/logs?limit=12`).then(
      (response) => response.json(),
    );
    assert.ok(Array.isArray(logs));

    const unauthorizedAccounts = await fetch(
      `${baseUrl}/api/xianyu/accounts`,
    );
    assert.equal(unauthorizedAccounts.status, 401);

    const accounts = await fetch(`${baseUrl}/api/xianyu/accounts`, {
      headers: { "X-API-Key": "xianyu-secret" },
    }).then((response) => response.json());
    assert.equal(accounts.items.length, 2);
    assert.equal(accounts.items[0].accountId, "account-a");

    const rejectedAccount = await fetch(
      `${baseUrl}/api/settings/xianyu`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ account_id: "other-account" }),
      },
    );
    assert.equal(rejectedAccount.status, 403);

    const savedAccount = await fetch(
      `${baseUrl}/api/settings/xianyu`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({
          account_id: "account-a",
          default_price: 3.5,
          title_template: "现货 {title}",
          description_template: "{description}\n{cloud_drives}",
          image_template: "https://cdn.example/{id}.jpg",
        }),
      },
    );
    assert.equal(savedAccount.status, 200);
    const savedAccountPayload = await savedAccount.json();
    assert.equal(savedAccountPayload.accountId, "account-a");
    assert.equal(savedAccountPayload.defaultPrice, 3.5);
    assert.equal(savedAccountPayload.titleTemplate, "现货 {title}");

    const settings = await fetch(
      `${baseUrl}/api/settings/xianyu`,
    ).then((response) => response.json());
    assert.equal(settings.accountId, "account-a");
    assert.equal(settings.defaultPrice, 3.5);
    assert.equal(settings.titleTemplate, "现货 {title}");
    assert.equal(
      settings.descriptionTemplate,
      "{description}\n{cloud_drives}",
    );
    assert.equal(
      settings.imageTemplate,
      "https://cdn.example/{id}.jpg",
    );

    const invalidTemplate = await fetch(
      `${baseUrl}/api/settings/xianyu`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({
          account_id: "account-a",
          default_price: 3.5,
          title_template: "{missing_variable}",
        }),
      },
    );
    assert.equal(invalidTemplate.status, 422);

    const savedGamePrice = await fetch(
      `${baseUrl}/api/games/118842/price`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ price: 6.8 }),
      },
    ).then((response) => response.json());
    assert.equal(savedGamePrice.salePrice, 6.8);
    assert.equal(savedGamePrice.effectivePrice, 6.8);

    const persisted = new CrawlerDatabase(databasePath);
    try {
      assert.equal(
        persisted.getXianyuSyncSettings().account_id,
        "account-a",
      );
      assert.equal(
        persisted.getXianyuSyncSettings().title_template,
        "现货 {title}",
      );
      assert.equal(
        persisted.queryOne(
          "SELECT sale_price FROM games WHERE id = ?",
          118842,
        ).sale_price,
        6.8,
      );
    } finally {
      persisted.close();
    }

    const unauthorizedSchedule = await fetch(
      `${baseUrl}/api/settings/schedule`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(unauthorizedSchedule.status, 401);

    const updatedSchedule = await fetch(
      `${baseUrl}/api/settings/schedule`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({
          cron_timezone: "Asia/Shanghai",
          crawl: {
            cron_schedule: "30 4 * * *",
            enabled: false,
          },
          sync: {
            cron_schedule: "15 */8 * * *",
            enabled: true,
            mode: "updated",
          },
        }),
      },
    ).then((response) => response.json());
    assert.equal(updatedSchedule.success, true);
    assert.equal(savedSchedule.crawlEnabled, false);
    assert.equal(savedSchedule.syncCronSchedule, "15 */8 * * *");
    assert.equal(savedSchedule.syncMode, "updated");

    const crawl = await fetch(`${baseUrl}/api/crawl/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "xianyu-secret",
      },
      body: JSON.stringify({}),
    });
    assert.equal(crawl.status, 202);
    assert.equal(crawlTrigger, "manual");

    const sync = await fetch(`${baseUrl}/api/sync/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "xianyu-secret",
      },
      body: JSON.stringify({ mode: "pending" }),
    });
    assert.equal(sync.status, 202);
    assert.equal((await sync.json()).mode, "pending");
    assert.deepEqual(syncTrigger, {
      trigger: "manual",
      mode: "pending",
      options: {},
    });

    const singleSync = await fetch(
      `${baseUrl}/api/games/118842/sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({}),
      },
    );
    assert.equal(singleSync.status, 202);
    assert.deepEqual(syncTrigger, {
      trigger: "manual-game",
      mode: "all",
      options: { gameIds: [118842] },
    });

    const interruptedSync = await fetch(
      `${baseUrl}/api/tasks/sync/interrupt`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({}),
      },
    ).then((response) => response.json());
    assert.equal(interruptedSync.success, true);
    assert.equal(interruptedSync.scheduler.sync.interrupted, true);
    assert.deepEqual(taskControl, {
      task: "sync",
      action: "interrupt",
    });

    const writeResponse = await fetch(`${baseUrl}/api/games`, {
      method: "POST",
    });
    assert.equal(writeResponse.status, 404);
  } finally {
    await dashboard.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
