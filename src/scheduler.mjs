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
    updatedAt: row.updated_at,
  };
}

function normalizeScheduleSettings(input) {
  const normalized = {
    cronTimezone: String(input.cronTimezone ?? "").trim(),
    crawlCronSchedule: String(input.crawlCronSchedule ?? "").trim(),
    crawlEnabled: input.crawlEnabled,
    syncCronSchedule: String(input.syncCronSchedule ?? "").trim(),
    syncEnabled: input.syncEnabled,
    syncMode: String(input.syncMode ?? "").trim(),
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
  activeRun = runCrawl({ trigger: reason, control })
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

function controlTask(task, action) {
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
  if (action === "interrupt") {
    control.interrupt();
  } else if (action === "resume") {
    control.resume();
  } else {
    const error = new Error("任务控制操作无效");
    error.statusCode = 422;
    throw error;
  }
  log("task_control_changed", {
    task,
    action,
    interrupted: control.interrupted,
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
        level: action === "interrupt" ? "warning" : "success",
        stage: "control",
        action,
        message:
          action === "interrupt"
            ? "管理员已请求中断任务，任务将在安全检查点暂停"
            : "管理员已恢复任务执行",
        details: { interrupted: control.interrupted },
        createdAt: nowIso(),
      });
    }
  } finally {
    database.close();
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
      materialConcurrency: materialSyncConcurrency,
      batchSize: publishBatchSize,
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
  crawlControl?.resume();
  syncControl?.resume();
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
