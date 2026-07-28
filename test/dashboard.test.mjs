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
    discoveredCount: 1,
    detailSucceeded: 1,
    detailFailed: 0,
    detailSkipped: 0,
  };
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
  database.close();

  let savedSchedule = null;
  let crawlTrigger = null;
  const dashboard = await startDashboardServer(
    {
      dashboardHost: "127.0.0.1",
      dashboardPort: 0,
      dbPath: databasePath,
      downloadReadApiKey: "download-secret",
      xianyuApiKey: "xianyu-secret",
      pageCount: 100,
      syncRunLimit: 20,
    },
    () => ({
      active: false,
      enabled: true,
      cronSchedule: "0 3 * * *",
      cronTimezone: "Asia/Shanghai",
      runOnStart: true,
      nextRun: "2026-07-28T19:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      sync: {
        active: false,
        enabled: true,
        cronSchedule: "0 */6 * * *",
        cronTimezone: "Asia/Shanghai",
        nextRun: "2026-07-28T18:00:00.000Z",
        batchSize: 20,
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
            enabled: settings.syncEnabled,
            cronSchedule: settings.syncCronSchedule,
            cronTimezone: settings.cronTimezone,
            nextRun: "2026-07-29T16:15:00.000Z",
          },
        };
      },
      triggerCrawl: (trigger) => {
        crawlTrigger = trigger;
        return { trigger, mode: "full", active: true };
      },
      triggerSync: (trigger) => ({
        trigger,
        mode: "full",
        active: true,
      }),
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
    assert.equal(summary.scheduler.cronTimezone, "Asia/Shanghai");

    const schedule = await fetch(
      `${baseUrl}/api/settings/schedule`,
    ).then((response) => response.json());
    assert.equal(schedule.crawl.cronSchedule, "0 3 * * *");
    assert.equal(schedule.sync.enabled, true);

    const games = await fetch(
      `${baseUrl}/api/games?query=118842&status=success`,
    ).then((response) => response.json());
    assert.equal(games.total, 1);
    assert.equal(games.items[0].title, "黄昏远征军");

    const detail = await fetch(`${baseUrl}/api/games/118842`).then(
      (response) => response.json(),
    );
    assert.equal(detail.game.archivePassword, "laoquzhang.com");
    assert.equal(detail.downloads[0].extractionCode, "e15a");

    const unauthorizedSources = await fetch(
      `${baseUrl}/api/download-sources?id=118842`,
    );
    assert.equal(unauthorizedSources.status, 401);

    const sources = await fetch(
      `${baseUrl}/api/download-sources?id=118842`,
      { headers: { "X-API-Key": "download-secret" } },
    ).then((response) => response.json());
    assert.equal(sources.downloads[0].extractionCode, "e15a");
    assert.equal(sources.game.id, 118842);

    const invalidQuery = await fetch(
      `${baseUrl}/api/download-sources?id=118842&name=黄昏远征军`,
      { headers: { "X-API-Key": "download-secret" } },
    );
    assert.equal(invalidQuery.status, 422);

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
        }),
      },
    );
    assert.equal(savedAccount.status, 200);
    const savedAccountPayload = await savedAccount.json();
    assert.equal(savedAccountPayload.accountId, "account-a");
    assert.equal(savedAccountPayload.defaultPrice, 3.5);

    const settings = await fetch(
      `${baseUrl}/api/settings/xianyu`,
    ).then((response) => response.json());
    assert.equal(settings.accountId, "account-a");
    assert.equal(settings.defaultPrice, 3.5);

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
          },
        }),
      },
    ).then((response) => response.json());
    assert.equal(updatedSchedule.success, true);
    assert.equal(savedSchedule.crawlEnabled, false);
    assert.equal(savedSchedule.syncCronSchedule, "15 */8 * * *");

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
      body: JSON.stringify({}),
    });
    assert.equal(sync.status, 202);
    assert.equal((await sync.json()).mode, "full");

    const page = await fetch(baseUrl).then((response) => response.text());
    assert.match(page, /G520 采集观测台/);

    const writeResponse = await fetch(`${baseUrl}/api/games`, {
      method: "POST",
    });
    assert.equal(writeResponse.status, 404);
  } finally {
    await dashboard.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
