import { Cron } from "croner";

import { loadConfig } from "./config.mjs";
import { runCrawl } from "./crawler.mjs";
import { CrawlerDatabase } from "./database.mjs";
import { startDashboardServer } from "./dashboard-server.mjs";
import {
  materialSyncConcurrency,
  publishBatchSize,
  XianyuSyncService,
} from "./sync-service.mjs";
import { TaskControl } from "./task-control.mjs";
import { nowIso, serializeError } from "./utils.mjs";

const config = loadConfig();
let activeRun = null;
let activeSync = null;
let crawlControl = null;
let syncControl = null;
let syncProgress = null;
let deferredSync = null;
let deferredCrawl = null;
let stopping = false;
let dashboard;
let crawlJob = null;
let syncJob = null;
let schedulerSettings;
let syncService;

function log(event, fields = {}) {
  console.log(
    JSON.stringify({
      timestamp: nowIso(),
      event,
      ...fields,
    }),
  );
}

function settingsFromRow(row) {
  return {
    cronTimezone: row.cron_timezone,
    crawlCronSchedule: row.crawl_cron_schedule,
    crawlEnabled: Boolean(row.crawl_enabled),
    syncCronSchedule: row.sync_cron_schedule,
    syncEnabled: Boolean(row.sync_enabled),
    syncMode: row.sync_mode ?? "all",
    crawlConcurrency: Number(row.crawl_concurrency),
    materialConcurrency: Number(row.material_concurrency),
    publishBatchSize: Number(row.publish_batch_size),
    publishLimit: Number(row.sync_publish_limit ?? 0),
    syncSort: row.sync_sort ?? "created",
    publishConcurrency: Number(row.publish_concurrency),
    updatedAt: row.updated_at,
  };
}

function concurrencyValue(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
    const error = new Error(`${label}必须是 1 到 12 之间的整数`);
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function publishBatchSizeValue(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    const error = new Error("每批发布商品数必须是 1 到 20 之间的整数");
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function publishLimitValue(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    const error = new Error("单次定时发布成功上限必须是 0 到 100000 之间的整数");
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function normalizeScheduleSettings(input) {
  const normalized = {
    cronTimezone: String(input.cronTimezone ?? "").trim(),
    crawlCronSchedule: String(input.crawlCronSchedule ?? "").trim(),
    crawlEnabled: input.crawlEnabled,
    syncCronSchedule: String(input.syncCronSchedule ?? "").trim(),
    syncEnabled: input.syncEnabled,
    syncMode: String(input.syncMode ?? "").trim(),
    crawlConcurrency: concurrencyValue(
      input.crawlConcurrency,
      "采集并行数",
    ),
    materialConcurrency: concurrencyValue(
      input.materialConcurrency,
      "素材导入并行数",
    ),
    publishBatchSize: publishBatchSizeValue(
      input.publishBatchSize ??
        schedulerSettings?.publishBatchSize ??
        publishBatchSize,
    ),
    publishLimit: publishLimitValue(
      input.publishLimit ?? schedulerSettings?.publishLimit ?? 0,
    ),
    syncSort: String(input.syncSort ?? schedulerSettings?.syncSort ?? "created").trim(),
    publishConcurrency: concurrencyValue(
      input.publishConcurrency ??
        schedulerSettings?.publishConcurrency ??
        4,
      "兼容发布并行数",
    ),
  };
  if (
    !normalized.cronTimezone ||
    normalized.cronTimezone.length > 80
  ) {
    const error = new Error("任务时区不能为空且不能超过 80 个字符");
    error.statusCode = 422;
    throw error;
  }
  if (!new Set(["all", "pending", "updated"]).has(normalized.syncMode)) {
    const error = new Error("定时同步范围必须是 all、pending 或 updated");
    error.statusCode = 422;
    throw error;
  }
  if (!new Set(["created", "updated", "hot"]).has(normalized.syncSort)) {
    const error = new Error("同步排序必须是 created、updated 或 hot");
    error.statusCode = 422;
    throw error;
  }
  if (
    !normalized.crawlCronSchedule ||
    normalized.crawlCronSchedule.length > 100 ||
    !normalized.syncCronSchedule ||
    normalized.syncCronSchedule.length > 100
  ) {
    const error = new Error("Cron 表达式不能为空且不能超过 100 个字符");
    error.statusCode = 422;
    throw error;
  }
  if (
    typeof normalized.crawlEnabled !== "boolean" ||
    typeof normalized.syncEnabled !== "boolean"
  ) {
    const error = new Error("任务启用状态必须是布尔值");
    error.statusCode = 422;
    throw error;
  }
  try {
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: normalized.cronTimezone,
    }).format(new Date());
  } catch {
    const error = new Error("任务时区无效");
    error.statusCode = 422;
    throw error;
  }
  return normalized;
}

function triggerCrawl(reason) {
  if (
    stopping ||
    (reason.startsWith("schedule") && !schedulerSettings.crawlEnabled)
  ) {
    return null;
  }
  if (activeRun) {
    log("schedule_skipped", {
      reason,
      message: "已有采集任务正在运行",
    });
    return activeRun;
  }
  if (activeSync) {
    deferredCrawl = reason;
    log("crawl_deferred", {
      reason,
      message: "闲鱼同步任务正在运行，采集将在同步结束后补跑",
    });
    return activeSync;
  }

  crawlControl = new TaskControl();
  const control = crawlControl;
  activeRun = runCrawl({
    trigger: reason,
    control,
    overrides: {
      detailConcurrency: schedulerSettings.crawlConcurrency,
    },
  })
    .catch((error) => {
      log("scheduled_crawl_failed", {
        reason,
        error: serializeError(error),
      });
    })
    .finally(() => {
      activeRun = null;
      if (crawlControl === control) crawlControl = null;
      if (deferredSync && !stopping) {
        const deferred = deferredSync;
        deferredSync = null;
        void triggerSync(
          deferred.reason,
          deferred.mode,
          deferred.options,
        );
      }
    });
  return activeRun;
}

function triggerSync(
  reason,
  mode = schedulerSettings.syncMode,
  options = {},
) {
  if (
    stopping ||
    (reason.startsWith("schedule") && !schedulerSettings.syncEnabled)
  ) {
    return null;
  }
  if (activeSync) {
    log("sync_skipped", {
      reason,
      message: "已有闲鱼同步任务正在运行",
    });
    return activeSync;
  }
  if (activeRun) {
    deferredSync = {
      reason: `${reason}-deferred`,
      mode,
      options,
    };
    log("sync_deferred", {
      reason,
      message: "采集任务正在运行，闲鱼同步将在采集结束后补跑",
    });
    return activeRun;
  }

  syncControl = new TaskControl();
  const control = syncControl;
  syncProgress = {
    total: 0,
    completed: 0,
    currentGameId: null,
    currentTitle: null,
    phase: "preparing",
  };
  activeSync = syncService
    .run({
      trigger: reason,
      mode,
      gameIds: options.gameIds ?? null,
      control,
      materialConcurrency: schedulerSettings.materialConcurrency,
      publishBatchSize: schedulerSettings.publishBatchSize,
      candidateSort: schedulerSettings.syncSort,
      publishLimit: reason.startsWith("schedule")
        ? schedulerSettings.publishLimit
        : 0,
      onProgress: (progress) => {
        syncProgress = progress;
      },
    })
    .then((result) => {
      log("xianyu_sync_completed", result);
      return result;
    })
    .catch((error) => {
      log("xianyu_sync_failed", {
        reason,
        error: serializeError(error),
      });
    })
    .finally(() => {
      activeSync = null;
      if (syncControl === control) syncControl = null;
      syncProgress = null;
      if (deferredCrawl && !stopping) {
        const deferred = deferredCrawl;
        deferredCrawl = null;
        void triggerCrawl(deferred);
      }
    });
  return activeSync;
}

function buildScheduledJobs(settings) {
  let nextCrawlJob = null;
  let nextSyncJob = null;
  try {
    if (settings.crawlEnabled) {
      nextCrawlJob = new Cron(
        settings.crawlCronSchedule,
        { timezone: settings.cronTimezone },
        () => {
          void triggerCrawl("schedule");
        },
      );
    }
    if (settings.syncEnabled) {
      nextSyncJob = new Cron(
        settings.syncCronSchedule,
        { timezone: settings.cronTimezone },
        () => {
          void triggerSync("schedule", settings.syncMode);
        },
      );
    }
    return {
      crawlJob: nextCrawlJob,
      syncJob: nextSyncJob,
    };
  } catch (cause) {
    nextCrawlJob?.stop();
    nextSyncJob?.stop();
    const error = new Error(`Cron 配置无效：${cause.message}`);
    error.statusCode = 422;
    throw error;
  }
}

function replaceScheduledJobs(settings, jobs = buildScheduledJobs(settings)) {
  crawlJob?.stop();
  syncJob?.stop();
  crawlJob = jobs.crawlJob;
  syncJob = jobs.syncJob;
  schedulerSettings = settings;
}

function updateScheduleSettings(input) {
  const normalized = normalizeScheduleSettings(input);
  const jobs = buildScheduledJobs(normalized);
  const updatedAt = nowIso();
  const database = new CrawlerDatabase(config.dbPath);
  let saved;
  try {
    saved = database.setSchedulerSettings(normalized, updatedAt);
  } catch (error) {
    jobs.crawlJob?.stop();
    jobs.syncJob?.stop();
    throw error;
  } finally {
    database.close();
  }
  replaceScheduledJobs(settingsFromRow(saved), jobs);
  log("scheduler_settings_updated", {
    cronTimezone: schedulerSettings.cronTimezone,
    crawlCronSchedule: schedulerSettings.crawlCronSchedule,
    crawlEnabled: schedulerSettings.crawlEnabled,
    syncCronSchedule: schedulerSettings.syncCronSchedule,
    syncEnabled: schedulerSettings.syncEnabled,
    syncMode: schedulerSettings.syncMode,
    crawlConcurrency: schedulerSettings.crawlConcurrency,
    materialConcurrency: schedulerSettings.materialConcurrency,
    publishBatchSize: schedulerSettings.publishBatchSize,
    publishLimit: schedulerSettings.publishLimit,
    syncSort: schedulerSettings.syncSort,
  });
  return scheduleRuntime();
}

async function updateXianyuApiKey(apiKey) {
  if (activeSync) {
    const error = new Error("同步任务运行中，不能修改闲鱼 API Key");
    error.statusCode = 409;
    throw error;
  }
  const nextService = new XianyuSyncService({
    ...config,
    xianyuApiKey: apiKey,
  });
  await nextService.listAccounts();
  const database = new CrawlerDatabase(config.dbPath);
  try {
    database.setXianyuApiKey(apiKey, nowIso());
  } finally {
    database.close();
  }
  config.xianyuApiKey = apiKey;
  syncService = nextService;
  log("xianyu_api_key_updated");
}

async function controlTask(task, action) {
  const control =
    task === "crawl"
      ? crawlControl
      : task === "sync"
        ? syncControl
        : null;
  const active = task === "crawl" ? activeRun : activeSync;
  if (!control || !active) {
    const error = new Error(
      task === "crawl" ? "当前没有采集任务" : "当前没有同步任务",
    );
    error.statusCode = 409;
    throw error;
  }
  if (action === "pause" || action === "interrupt") {
    control.pause();
  } else if (action === "resume") {
    control.resume();
  } else if (action === "terminate") {
    deferredSync = null;
    deferredCrawl = null;
    control.terminate();
  } else {
    const error = new Error("任务控制操作无效");
    error.statusCode = 422;
    throw error;
  }
  log("task_control_changed", {
    task,
    action,
    interrupted: control.interrupted,
    terminated: control.terminated,
  });
  const database = new CrawlerDatabase(config.dbPath);
  try {
    const runId =
      task === "sync"
        ? syncProgress?.runId
        : database.queryOne(
            "SELECT id FROM crawl_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1",
          )?.id;
    if (runId) {
      database.recordTaskLog({
        taskType: task,
        runId,
        level:
          action === "pause" ||
          action === "interrupt" ||
          action === "terminate"
            ? "warning"
            : "success",
        stage: "control",
        action: action === "interrupt" ? "pause" : action,
        message:
          action === "pause" || action === "interrupt"
            ? "管理员已立即暂停任务，停止领取新的处理步骤"
            : action === "terminate"
              ? "管理员已终止任务，任务将退出且不能恢复"
              : "管理员已恢复任务执行",
        details: {
          interrupted: control.interrupted,
          terminated: control.terminated,
        },
        createdAt: nowIso(),
      });
    }
  } finally {
    database.close();
  }
  if (action === "terminate") {
    await active;
  }
  return scheduleRuntime();
}

function scheduleRuntime() {
  return {
    active: Boolean(activeRun),
    interrupted: Boolean(crawlControl?.interrupted),
    enabled: schedulerSettings.crawlEnabled,
    cronSchedule: schedulerSettings.crawlCronSchedule,
    cronTimezone: schedulerSettings.cronTimezone,
    runOnStart: config.runOnStart,
    concurrency: schedulerSettings.crawlConcurrency,
    nextRun: crawlJob?.nextRun()?.toISOString() ?? null,
    updatedAt: schedulerSettings.updatedAt,
    sync: {
      active: Boolean(activeSync),
      interrupted: Boolean(syncControl?.interrupted),
      enabled: schedulerSettings.syncEnabled,
      deferred: Boolean(deferredSync),
      cronSchedule: schedulerSettings.syncCronSchedule,
      cronTimezone: schedulerSettings.cronTimezone,
      nextRun: syncJob?.nextRun()?.toISOString() ?? null,
      materialConcurrency: schedulerSettings.materialConcurrency,
      publishBatchSize: schedulerSettings.publishBatchSize,
      publishLimit: schedulerSettings.publishLimit,
      sort: schedulerSettings.syncSort,
      mode: schedulerSettings.syncMode,
      progress: syncProgress,
    },
  };
}

const database = new CrawlerDatabase(config.dbPath);
database.markInterruptedRuns(nowIso());
config.xianyuApiKey = database.getXianyuApiKey(
  config.xianyuApiKey,
);
if (config.xianyuApiKey && !database.getXianyuApiKey()) {
  database.setXianyuApiKey(config.xianyuApiKey, nowIso());
}
schedulerSettings = settingsFromRow(
  database.getSchedulerSettings(
    {
      cronTimezone: config.cronTimezone,
      crawlCronSchedule: config.cronSchedule,
      crawlEnabled: config.crawlEnabled,
      syncCronSchedule: config.syncCronSchedule,
      syncEnabled: config.syncEnabled,
      syncMode: "all",
      crawlConcurrency: config.detailConcurrency,
      materialConcurrency: materialSyncConcurrency,
      publishBatchSize,
      publishLimit: 0,
      syncSort: "created",
      publishConcurrency: 4,
    },
    nowIso(),
  ),
);
database.close();
syncService = new XianyuSyncService(config);
replaceScheduledJobs(schedulerSettings);

dashboard = await startDashboardServer(config, scheduleRuntime, {
  listXianyuAccounts: () => syncService.listAccounts(),
  validateXianyuAccount: (accountId) =>
    syncService.validateAccount(accountId),
  syncXianyuPublishedItems: () => syncService.syncAccountPublishedItems(),
  updateScheduleSettings,
  updateXianyuApiKey,
  triggerCrawl: (reason) => {
    void triggerCrawl(reason);
    return { active: true, mode: "full" };
  },
  triggerSync: (reason, mode, options = {}) => {
    void triggerSync(reason, mode, options);
    return {
      active: true,
      mode,
      gameIds: options.gameIds ?? null,
    };
  },
  controlTask,
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  crawlJob?.stop();
  syncJob?.stop();
  crawlControl?.terminate();
  syncControl?.terminate();
  log("scheduler_stopping", { signal });
  await Promise.allSettled(
    [activeRun, activeSync].filter(Boolean),
  );
  await dashboard.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

log("scheduler_started", {
  cronSchedule: schedulerSettings.crawlCronSchedule,
  cronTimezone: schedulerSettings.cronTimezone,
  crawlEnabled: schedulerSettings.crawlEnabled,
  runOnStart: config.runOnStart,
  nextRun: crawlJob?.nextRun()?.toISOString() ?? null,
  syncEnabled: schedulerSettings.syncEnabled,
  syncCronSchedule: schedulerSettings.syncCronSchedule,
  syncNextRun: syncJob?.nextRun()?.toISOString() ?? null,
  dashboard: `http://${config.dashboardHost}:${config.dashboardPort}`,
});

if (config.runOnStart && schedulerSettings.crawlEnabled) {
  await triggerCrawl("startup");
}
