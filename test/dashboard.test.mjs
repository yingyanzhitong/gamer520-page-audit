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
    tags: ["PC PLAY", "虚拟机"],
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
    "account-a",
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
  database.upsertDiscoveredGames(
    [
      {
        id: 118843,
        sourceUrl: "https://www.gamer520.com/118843.html",
        title: "缺少下载资源的游戏",
        imageUrl: "https://images.example/118843.jpg",
        hotPage: 1,
        hotPosition: 2,
        hotRank: 2,
      },
    ],
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
  database.recordTaskLog({
    taskType: "sync",
    runId: syncRunId,
    gameId: game.id,
    level: "success",
    stage: "publish",
    action: "success",
    message: "测试商品发布成功",
    details: { itemId: "1067769058126" },
    createdAt: "2026-07-28T00:01:50.000Z",
  });
  database.close();

  let savedSchedule = null;
  let runtimeSyncTasks = null;
  let crawlTrigger = null;
  let syncTrigger = null;
  let taskControl = null;
  let xianyuItemSyncCalls = 0;
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
      concurrency: 3,
      nextRun: "2026-07-28T19:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      sync: {
        active: false,
        interrupted: false,
        enabled: true,
        cronTimezone: "Asia/Shanghai",
        nextRun: "2026-07-28T18:00:00.000Z",
        accountIds: ["account-a", "account-b"],
        tasks: runtimeSyncTasks ?? [
          {
            accountId: "account-a",
            enabled: true,
            cronSchedule: "0 */6 * * *",
            mode: "all",
            gameIds: [],
            nextRun: "2026-07-28T18:00:00.000Z",
            materialConcurrency: 4,
            publishBatchSize: 20,
            publishLimit: 0,
            sort: "created",
          },
          {
            accountId: "account-b",
            enabled: false,
            cronSchedule: "30 9 * * *",
            mode: "pending",
            gameIds: [],
            nextRun: null,
            materialConcurrency: 2,
            publishBatchSize: 5,
            publishLimit: 10,
            sort: "hot",
          },
        ],
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
          accountId: "account-b",
          enabled: true,
          remark: "副账号",
        },
        {
          accountId: "account-disabled",
          enabled: false,
          remark: "停用",
        },
      ],
      listXianyuCards: async () => [
        { id: 6, name: "默认卡券", type: "text", enabled: true },
        { id: 9, name: "已停用卡券", type: "api", enabled: false },
      ],
      getXianyuAccountPublishCapability: async (accountId) => ({
        account_id: accountId,
        account_type: accountId === "account-b" ? "fish-shop" : "personal",
        supports: {
          quantity: accountId === "account-b",
          specifications: accountId === "account-b",
          sku_rows: accountId === "account-b",
          shipping_methods:
            accountId === "account-b"
              ? ["free", "none"]
              : ["free", "distance", "fixed", "none"],
        },
      }),
      syncXianyuPublishedItems: async (accountId) => {
        xianyuItemSyncCalls += 1;
        return {
          accountId,
          accountItemCount: 3,
          localItemCount: 2,
          confirmedCount: 1,
          titleMatchedCount: 0,
          materialFallbackCount: 1,
        };
      },
      updateScheduleSettings: (settings) => {
        savedSchedule = settings;
        runtimeSyncTasks = settings.syncTasks;
        return {
          active: false,
          enabled: settings.crawlEnabled,
          cronSchedule: settings.crawlCronSchedule,
          cronTimezone: settings.cronTimezone,
          concurrency: settings.crawlConcurrency,
          nextRun: "2026-07-29T20:30:00.000Z",
          sync: {
            active: false,
            interrupted: false,
            enabled: settings.syncTasks.some((task) => task.enabled),
            cronTimezone: settings.cronTimezone,
            nextRun: "2026-07-29T16:15:00.000Z",
            accountIds: settings.syncTasks.map((task) => task.accountId),
            tasks: settings.syncTasks.map((task, index) => ({
              ...task,
              nextRun:
                task.enabled && index === 0
                  ? "2026-07-29T16:15:00.000Z"
                  : null,
            })),
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
          active: action === "terminate" ? false : task === "crawl",
          interrupted: action === "pause" || action === "interrupt",
          sync: {
            active: action === "terminate" ? false : task === "sync",
            interrupted:
              task === "sync" &&
              (action === "pause" || action === "interrupt"),
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
    assert.equal(summary.totals.games, 2);
    assert.equal(summary.totals.downloads, 1);
    assert.equal(summary.totals.validGames, 1);
    assert.equal(summary.totals.eligibleGames, 1);
    assert.equal(summary.latestRun.status, "success");
    assert.equal(summary.latestRun.detailSkipped, 2);
    assert.equal(summary.scheduler.cronTimezone, "Asia/Shanghai");

    const schedule = await fetch(
      `${baseUrl}/api/settings/schedule`,
    ).then((response) => response.json());
    assert.equal(schedule.crawl.cronSchedule, "0 3 * * *");
    assert.equal(schedule.crawl.concurrency, 3);
    assert.equal(schedule.sync.enabled, true);
    assert.equal(schedule.sync.tasks.length, 2);
    assert.equal(schedule.sync.tasks[0].mode, "all");
    assert.equal(schedule.sync.tasks[0].materialConcurrency, 4);
    assert.equal(schedule.sync.tasks[1].cronSchedule, "30 9 * * *");
    assert.equal(schedule.sync.tasks[1].publishLimit, 10);
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
    assert.match(appSource, /每个发布账号有一条独立的定时任务/);
    assert.doesNotMatch(appSource, /配置账号 account_id/);
    assert.match(appSource, /每个账号单独保存可发布参数/);
    assert.match(appSource, /游戏数据/);
    assert.match(appSource, /API Key 管理/);
    assert.match(appSource, /导入素材库/);
    assert.match(appSource, /发布成功/);
    assert.match(appSource, /发布状态账号/);
    assert.match(appSource, /查询发布状态/);
    assert.match(appSource, /同步排序/);
    assert.match(appSource, /热度从高到低/);
    assert.match(appSource, /创建时间从晚到早/);
    assert.match(appSource, /更新时间从晚到早/);
    assert.match(appSource, /热度从低到高/);
    assert.match(appSource, /按热度排序/);
    assert.match(appSource, /按创建时间/);
    assert.match(appSource, /按更新时间/);
    assert.match(appSource, /可发布/);
    assert.doesNotMatch(appSource, /更新素材库/);
    assert.match(appSource, /缺失/);
    assert.match(appSource, /标签/);
    assert.match(appSource, /全部标签/);
    assert.doesNotMatch(appSource, /缺少图片或资源/);
    assert.match(appSource, /图片链接/);
    assert.match(appSource, /图片预览加载失败/);
    assert.match(appSource, /总游戏数据/);
    assert.match(appSource, /有效游戏数据/);
    assert.match(appSource, /已同步素材库数据/);
    assert.match(appSource, /已发布数据/);
    assert.match(appSource, /查看日志/);
    assert.match(appSource, /已有跳过/);
    assert.match(appSource, /每批发布商品数/);
    assert.match(appSource, /Gamer520 API Key/);
    assert.match(appSource, /更换 Key/);

    const games = await fetch(
      `${baseUrl}/api/games?query=118842&status=success`,
    ).then((response) => response.json());
    assert.equal(games.total, 1);
    assert.equal(games.items[0].title, "黄昏远征军");
    assert.deepEqual(games.items[0].tags, ["PC PLAY", "虚拟机"]);
    assert.deepEqual(games.availableTags, ["PC PLAY", "虚拟机"]);
    assert.equal(games.items[0].xianyuItemId, "1067769058126");
    assert.equal(games.items[0].isValid, true);

    const gamesByTag = await fetch(
      `${baseUrl}/api/games?query=${encodeURIComponent("虚拟机")}`,
    ).then((response) => response.json());
    assert.equal(gamesByTag.total, 1);
    assert.equal(gamesByTag.items[0].id, 118842);

    const gamesByTagFilter = await fetch(
      `${baseUrl}/api/games?tag=${encodeURIComponent("虚拟机")}&status=success`,
    ).then((response) => response.json());
    assert.equal(gamesByTagFilter.total, 1);
    assert.equal(gamesByTagFilter.tag, "虚拟机");
    assert.equal(gamesByTagFilter.items[0].id, 118842);

    const gamesByMissingTag = await fetch(
      `${baseUrl}/api/games?tag=${encodeURIComponent("不存在的标签")}`,
    ).then((response) => response.json());
    assert.equal(gamesByMissingTag.total, 0);

    const accountSwitchDatabase = new CrawlerDatabase(databasePath);
    accountSwitchDatabase.setXianyuAccountId(
      "account-b",
      "2026-07-28T00:01:45.000Z",
    );
    accountSwitchDatabase.close();
    const accountBStates = await fetch(
      `${baseUrl}/api/games?query=118842&xianyuStatus=none&accountId=account-b`,
    ).then((response) => response.json());
    assert.equal(accountBStates.total, 1);
    assert.equal(accountBStates.accountId, "account-b");
    assert.equal(accountBStates.items[0].xianyuStatus, "none");
    assert.equal(accountBStates.items[0].xianyuItemId, null);
    const accountBPublishableGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=publishable&accountId=account-b`,
    ).then((response) => response.json());
    assert.equal(accountBPublishableGames.total, 1);
    assert.equal(accountBPublishableGames.items[0].id, game.id);
    const accountBDashboard = await fetch(`${baseUrl}/api/dashboard`).then(
      (response) => response.json(),
    );
    assert.equal(accountBDashboard.totals.publishedGames, 1);
    assert.deepEqual(accountBDashboard.xianyu.accountIds, [
      "account-a",
      "account-b",
    ]);
    const restoreAccountDatabase = new CrawlerDatabase(databasePath);
    restoreAccountDatabase.setXianyuAccountId(
      "account-a",
      "2026-07-28T00:01:46.000Z",
    );
    restoreAccountDatabase.close();

    const validGames = await fetch(
      `${baseUrl}/api/games?validOnly=true`,
    ).then((response) => response.json());
    assert.equal(validGames.total, 1);
    assert.equal(validGames.items[0].id, 118842);
    assert.equal(validGames.items[0].isValid, true);

    const updatedPublishedGames = await fetch(
      `${baseUrl}/api/games?status=updated&xianyuStatus=published`,
    ).then((response) => response.json());
    assert.equal(updatedPublishedGames.total, 1);
    assert.equal(updatedPublishedGames.items[0].lastChangeType, "updated");
    assert.equal(
      updatedPublishedGames.items[0].xianyuStatus,
      "published",
    );

    const xianyuItemsSync = await fetch(
      `${baseUrl}/api/xianyu/items/sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ account_id: "account-a" }),
      },
    ).then((response) => response.json());
    assert.equal(xianyuItemsSync.success, true);
    assert.equal(xianyuItemsSync.accountId, "account-a");
    assert.equal(xianyuItemsSync.confirmedCount, 1);
    assert.equal(xianyuItemsSync.titleMatchedCount, 0);
    assert.equal(xianyuItemsSync.materialFallbackCount, 1);
    assert.equal(xianyuItemSyncCalls, 1);

    const noXianyuStateGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=none`,
    ).then((response) => response.json());
    assert.equal(noXianyuStateGames.total, 1);
    assert.equal(noXianyuStateGames.items[0].isValid, false);

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
    assert.equal(detail.game.isValid, true);
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
      "account-a",
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
    materialDatabase.database
      .prepare(`
        UPDATE games
        SET xianyu_item_id = NULL, xianyu_item_url = NULL
        WHERE id = ?
      `)
      .run(game.id);
    materialDatabase.database
      .prepare(`
        UPDATE xianyu_publications
        SET item_id = NULL, item_url = NULL
        WHERE game_id = ? AND account_id = ?
      `)
      .run(game.id, "account-a");
    materialDatabase.close();
    const materialGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=material`,
    ).then((response) => response.json());
    assert.equal(materialGames.total, 1);
    assert.equal(materialGames.items[0].xianyuStatus, "material");
    const retryablePublishableGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=publishable`,
    ).then((response) => response.json());
    assert.equal(retryablePublishableGames.total, 1);
    assert.equal(retryablePublishableGames.items[0].id, game.id);

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
    assert.equal(noneGames.total, 2);
    assert.ok(
      noneGames.items.some(
        (item) => item.id === game.id && item.xianyuStatus === "none",
      ),
    );

    const otherAccountDatabase = new CrawlerDatabase(databasePath);
    otherAccountDatabase.database
      .prepare(`
        UPDATE games
        SET xianyu_item_id = ?, xianyu_account_id = ?
        WHERE id = ?
      `)
      .run("item-from-other-account", "account-b", game.id);
    otherAccountDatabase.close();
    const currentAccountNoneGames = await fetch(
      `${baseUrl}/api/games?xianyuStatus=none`,
    ).then((response) => response.json());
    assert.ok(
      currentAccountNoneGames.items.some(
        (item) => item.id === game.id && item.xianyuStatus === "none",
      ),
    );
    const clearOtherAccountDatabase = new CrawlerDatabase(databasePath);
    clearOtherAccountDatabase.database
      .prepare(`
        UPDATE games
        SET xianyu_item_id = NULL, xianyu_account_id = NULL
        WHERE id = ?
      `)
      .run(game.id);
    clearOtherAccountDatabase.close();

    const sortDatabase = new CrawlerDatabase(databasePath);
    const sortGames = [
      {
        id: 118844,
        sourceUrl: "https://www.gamer520.com/118844.html",
        title: "排序测试 Alpha",
        imageUrl: "https://images.example/118844.jpg",
        hotPage: 1,
        hotPosition: 2,
        hotRank: 2,
        createdAt: "2026-07-28T00:11:00.000Z",
        updatedAt: "2026-07-28T00:31:00.000Z",
      },
      {
        id: 118845,
        sourceUrl: "https://www.gamer520.com/118845.html",
        title: "排序测试 Beta",
        imageUrl: "https://images.example/118845.jpg",
        hotPage: 1,
        hotPosition: 1,
        hotRank: 1,
        createdAt: "2026-07-28T00:12:00.000Z",
        updatedAt: "2026-07-28T00:33:00.000Z",
      },
      {
        id: 118846,
        sourceUrl: "https://www.gamer520.com/118846.html",
        title: "排序测试 Gamma",
        imageUrl: "https://images.example/118846.jpg",
        hotPage: null,
        hotPosition: null,
        hotRank: null,
        createdAt: "2026-07-28T00:13:00.000Z",
        updatedAt: "2026-07-28T00:32:00.000Z",
      },
    ];
    for (const sortGame of sortGames) {
      sortDatabase.upsertDiscoveredGames([sortGame], sortGame.createdAt);
      sortDatabase.saveGameSuccess(
        sortGame,
        {
          page: {
            url: sortGame.sourceUrl,
            title: sortGame.title,
            image: sortGame.imageUrl,
            gameDescription: "排序测试游戏简介",
          },
          resource: {
            resourceCode: `A${sortGame.id}`,
            detailPageUrl: sortGame.sourceUrl,
            archivePassword: "test-password",
            downloads: [
              {
                provider: "百度网盘",
                url: `https://pan.example/${sortGame.id}`,
                password: null,
                extractionCode: null,
                qrImageUrl: null,
                qrDecodeMethod: "test",
              },
            ],
          },
        },
        sortGame.updatedAt,
      );
    }
    sortDatabase.close();

    const hotSortedGames = await fetch(
      `${baseUrl}/api/games?query=${encodeURIComponent("排序测试")}&sort=hot`,
    ).then((response) => response.json());
    assert.equal(hotSortedGames.sort, "hot");
    assert.deepEqual(
      hotSortedGames.items.map((item) => item.id),
      [118845, 118844, 118846],
    );

    const createdSortedGames = await fetch(
      `${baseUrl}/api/games?query=${encodeURIComponent("排序测试")}&sort=created`,
    ).then((response) => response.json());
    assert.equal(createdSortedGames.sort, "created");
    assert.deepEqual(
      createdSortedGames.items.map((item) => item.id),
      [118846, 118845, 118844],
    );

    const updatedSortedGames = await fetch(
      `${baseUrl}/api/games?query=${encodeURIComponent("排序测试")}&sort=updated`,
    ).then((response) => response.json());
    assert.equal(updatedSortedGames.sort, "updated");
    assert.deepEqual(
      updatedSortedGames.items.map((item) => item.id),
      [118845, 118846, 118844],
    );

    const invalidSortedGames = await fetch(
      `${baseUrl}/api/games?query=${encodeURIComponent("排序测试")}&sort=unknown`,
    ).then((response) => response.json());
    assert.equal(invalidSortedGames.sort, "hot");

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
    const operationLogs = await fetch(
      `${baseUrl}/api/task-logs?task_type=sync&run_id=${syncRunId}&after_id=0&limit=20`,
    ).then((response) => response.json());
    assert.equal(operationLogs.items.length, 1);
    assert.equal(operationLogs.items[0].action, "success");
    assert.equal(
      operationLogs.items[0].details.itemId,
      "1067769058126",
    );

    const unauthorizedAccounts = await fetch(
      `${baseUrl}/api/xianyu/accounts`,
    );
    assert.equal(unauthorizedAccounts.status, 401);

    const accounts = await fetch(`${baseUrl}/api/xianyu/accounts`, {
      headers: { "X-API-Key": "xianyu-secret" },
    }).then((response) => response.json());
    assert.equal(accounts.items.length, 3);
    assert.equal(accounts.items[0].accountId, "account-a");

    const cards = await fetch(`${baseUrl}/api/xianyu/cards`, {
      headers: { "X-API-Key": "xianyu-secret" },
    }).then((response) => response.json());
    assert.deepEqual(cards.items, [
      { id: 6, name: "默认卡券", type: "text", enabled: true },
      { id: 9, name: "已停用卡券", type: "api", enabled: false },
    ]);

    const capability = await fetch(
      `${baseUrl}/api/xianyu/accounts/capability?accountId=account-b`,
      { headers: { "X-API-Key": "xianyu-secret" } },
    ).then((response) => response.json());
    assert.equal(capability.account_type, "fish-shop");
    assert.deepEqual(capability.supports.shipping_methods, ["free", "none"]);

    const savedSettings = await fetch(
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
          default_stock: 88,
          publish_mode: "shop-batch",
          title_template: "现货 {title}",
          description_template: "{description}\n{cloud_drives}",
          image_template: "https://cdn.example/{id}.jpg",
          publish_options: { cardId: 9 },
        }),
      },
    );
    assert.equal(savedSettings.status, 200);
    const savedSettingsPayload = await savedSettings.json();
    assert.equal(savedSettingsPayload.defaultPrice, 3.5);
    assert.equal(savedSettingsPayload.defaultStock, 88);
    assert.equal(savedSettingsPayload.publishMode, "account-auto");
    assert.equal(savedSettingsPayload.titleTemplate, "现货 {title}");
    assert.equal(savedSettingsPayload.publishOptions.cardId, 9);

    const settings = await fetch(
      `${baseUrl}/api/settings/xianyu?accountId=account-a`,
    ).then((response) => response.json());
    assert.equal(settings.accountId, "account-a");
    assert.equal(settings.defaultPrice, 3.5);
    assert.equal(settings.defaultStock, 88);
    assert.equal(settings.publishMode, "account-auto");
    assert.equal(settings.publishOptions.cardId, 9);
    assert.equal(settings.titleTemplate, "现货 {title}");
    assert.equal(
      settings.descriptionTemplate,
      "{description}\n{cloud_drives}",
    );
    assert.equal(
      settings.imageTemplate,
      "https://cdn.example/{id}.jpg",
    );
    assert.equal(settings.items, undefined);

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

    const invalidStock = await fetch(
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
          default_stock: 0,
        }),
      },
    );
    assert.equal(invalidStock.status, 422);

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
      assert.equal(persisted.getXianyuSyncSettings().default_stock, 88);
      assert.equal(
        persisted.getXianyuSyncSettings().publish_mode,
        "batch",
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
            concurrency: 5,
          },
          sync: {
            tasks: [
              {
                account_id: "account-a",
                cron_schedule: "15 */8 * * *",
                enabled: true,
                mode: "selected-force",
                selected_game_ids: [118842],
                material_concurrency: 6,
                publish_batch_size: 8,
                publish_limit: 42,
                sort: "created-desc",
              },
              {
                account_id: "account-b",
                cron_schedule: "30 9 * * *",
                enabled: false,
                mode: "pending",
                selected_game_ids: [],
                material_concurrency: 2,
                publish_batch_size: 5,
                publish_limit: 10,
                sort: "hot-asc",
              },
            ],
          },
        }),
      },
    ).then((response) => response.json());
    assert.equal(updatedSchedule.success, true);
    assert.equal(savedSchedule.crawlEnabled, false);
    assert.equal(savedSchedule.crawlConcurrency, 5);
    assert.equal(savedSchedule.syncTasks.length, 2);
    assert.deepEqual(savedSchedule.syncTasks[0], {
      accountId: "account-a",
      cronSchedule: "15 */8 * * *",
      enabled: true,
      mode: "selected-force",
      gameIds: [118842],
      materialConcurrency: 6,
      publishBatchSize: 8,
      publishLimit: 42,
      sort: "created-desc",
    });
    assert.equal(savedSchedule.syncTasks[1].accountId, "account-b");
    assert.equal(savedSchedule.syncTasks[1].cronSchedule, "30 9 * * *");
    assert.equal(savedSchedule.syncTasks[1].publishBatchSize, 5);
    assert.equal(savedSchedule.syncTasks[1].sort, "hot-asc");
    assert.equal(savedSchedule.publishConcurrency, undefined);

    const crawl = await fetch(`${baseUrl}/api/crawl/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "xianyu-secret",
      },
      body: JSON.stringify({}),
    });
    assert.equal(crawl.status, 200);
    assert.equal(crawlTrigger, "manual");

    const sync = await fetch(`${baseUrl}/api/sync/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "xianyu-secret",
      },
      body: JSON.stringify({
        mode: "pending",
        account_ids: ["account-a", "account-b"],
      }),
    });
    assert.equal(sync.status, 200);
    assert.equal((await sync.json()).mode, "pending");
    assert.deepEqual(syncTrigger, {
      trigger: "manual",
      mode: "pending",
      options: { accountIds: ["account-a", "account-b"] },
    });

    const configuredSync = await fetch(`${baseUrl}/api/sync/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "xianyu-secret",
      },
      body: JSON.stringify({
        use_configured_task: true,
        account_ids: ["account-a"],
      }),
    });
    assert.equal(configuredSync.status, 200);
    assert.equal((await configuredSync.json()).message, "已按设定启动同步任务");
    assert.deepEqual(syncTrigger, {
      trigger: "manual",
      mode: "selected-force",
      options: {
        accountIds: ["account-a"],
        useConfiguredTask: true,
        tasks: [
          {
            accountId: "account-a",
            cronSchedule: "15 */8 * * *",
            enabled: true,
            mode: "selected-force",
            gameIds: [118842],
            materialConcurrency: 6,
            publishBatchSize: 8,
            publishLimit: 42,
            sort: "created-desc",
          },
        ],
        gameIds: [118842],
      },
    });

    const singleSync = await fetch(
      `${baseUrl}/api/games/118842/sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ account_id: "account-a" }),
      },
    );
    assert.equal(singleSync.status, 200);
    assert.deepEqual(syncTrigger, {
      trigger: "manual-game",
      mode: "all",
      options: { gameIds: [118842], accountIds: ["account-a"] },
    });

    const missingAccountGameSync = await fetch(
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
    assert.equal(missingAccountGameSync.status, 422);
    assert.match(
      (await missingAccountGameSync.json()).error,
      /请选择要发布的闲鱼账号/,
    );

    const missingGameSync = await fetch(
      `${baseUrl}/api/games/118843/sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ account_id: "account-a" }),
      },
    );
    assert.equal(missingGameSync.status, 422);
    assert.match(
      (await missingGameSync.json()).error,
      /采集状态不是成功/,
    );

    const selectedSync = await fetch(
      `${baseUrl}/api/games/sync-selected`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ gameIds: [118842, 118842] }),
      },
    );
    assert.equal(selectedSync.status, 200);
    const selectedPayload = await selectedSync.json();
    assert.equal(selectedPayload.selectedCount, 1);
    assert.deepEqual(selectedPayload.gameIds, [118842]);
    assert.deepEqual(syncTrigger, {
      trigger: "manual-selected",
      mode: "all",
      options: { gameIds: [118842] },
    });

    const invalidSelectedSync = await fetch(
      `${baseUrl}/api/games/sync-selected`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ gameIds: [118843] }),
      },
    );
    assert.equal(invalidSelectedSync.status, 422);
    assert.match(
      (await invalidSelectedSync.json()).error,
      /缺少有效图片、下载资源/,
    );

    const markedViolation = await fetch(
      `${baseUrl}/api/games/118842/scrape-status`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ status: "violation" }),
      },
    ).then((response) => response.json());
    assert.equal(markedViolation.scrapeStatus, "violation");

    const violationGames = await fetch(
      `${baseUrl}/api/games?status=violation`,
    ).then((response) => response.json());
    assert.equal(violationGames.total, 1);
    assert.equal(violationGames.items[0].id, 118842);
    assert.equal(violationGames.items[0].isValid, false);

    const violationSync = await fetch(
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
    assert.equal(violationSync.status, 422);

    const restoredViolation = await fetch(
      `${baseUrl}/api/games/118842/scrape-status`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ status: "success" }),
      },
    ).then((response) => response.json());
    assert.equal(restoredViolation.scrapeStatus, "success");

    const invalidScrapeStatus = await fetch(
      `${baseUrl}/api/games/118842/scrape-status`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({ status: "failed" }),
      },
    );
    assert.equal(invalidScrapeStatus.status, 422);

    const interruptedSync = await fetch(
      `${baseUrl}/api/tasks/sync/pause`,
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
      action: "pause",
    });

    const terminatedSync = await fetch(
      `${baseUrl}/api/tasks/sync/terminate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": "xianyu-secret",
        },
        body: JSON.stringify({}),
      },
    ).then((response) => response.json());
    assert.equal(terminatedSync.success, true);
    assert.equal(terminatedSync.scheduler.sync.active, false);
    assert.deepEqual(taskControl, {
      task: "sync",
      action: "terminate",
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
